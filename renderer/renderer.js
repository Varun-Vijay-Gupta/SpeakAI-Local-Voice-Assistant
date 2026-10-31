'use strict';

/* ------------------------------------------------------------------ config */
const SAMPLE_RATE = 16000; // Whisper expects 16 kHz mono float PCM
const CHUNK_SECONDS = 4; // how much audio is sent to Whisper per pass
const MIN_CHUNK_SECONDS = 0.5;
const SILENCE_RMS = 0.004; // chunks quieter than this are skipped

/* --------------------------------------------------------------------- dom */
const el = {
  start: document.getElementById('btn-start'),
  stop: document.getElementById('btn-stop'),
  suggest: document.getElementById('btn-suggest'),
  abort: document.getElementById('btn-abort'),
  clear: document.getElementById('btn-clear'),
  level: document.getElementById('level'),
  timer: document.getElementById('timer'),
  transcript: document.getElementById('transcript'),
  answer: document.getElementById('answer'),
  whisperModel: document.getElementById('whisper-model'),
  language: document.getElementById('language'),
  llmModel: document.getElementById('llm-model'),
  autoSuggest: document.getElementById('auto-suggest'),
  whisperDot: document.getElementById('whisper-dot'),
  whisperText: document.getElementById('whisper-text'),
  ollamaDot: document.getElementById('ollama-dot'),
  ollamaText: document.getElementById('ollama-text'),
  footerInfo: document.getElementById('footer-info'),
};

const store = {
  get(key, fallback) {
    const value = localStorage.getItem(`speakai.${key}`);
    return value === null ? fallback : value;
  },
  set(key, value) {
    localStorage.setItem(`speakai.${key}`, value);
  },
};

/* ------------------------------------------------------------------- state */
const state = {
  recording: false,
  whisperReady: false,
  transcribing: 0,
  chunks: [],
  pendingSamples: 0,
  timerId: null,
  startedAt: 0,
  streamRequestId: null,
  answerText: '',
  lastQuestion: '',
  autoAnswered: new Set(),
};

let audioContext = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;

/* ------------------------------------------------------------------ helpers */
function setDot(node, kind) {
  node.classList.remove('ok', 'busy', 'err');
  if (kind) node.classList.add(kind);
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function concatChunks(chunks, totalSamples) {
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function scrollToBottom(node) {
  node.scrollTop = node.scrollHeight;
}

function clearPlaceholder(node) {
  const placeholder = node.querySelector('.placeholder');
  if (placeholder) placeholder.remove();
}

function setBusy(button, busyText, idleText) {
  button.textContent = busyText;
  button.disabled = true;
  return () => {
    button.textContent = idleText;
    button.disabled = false;
  };
}

/* ------------------------------------------------------------ whisper status */
async function loadWhisper(model) {
  el.whisperText.textContent = 'Whisper: loading';
  setDot(el.whisperDot, 'busy');
  el.start.disabled = true;
  try {
    const result = await window.speakai.whisper.load(model);
    state.whisperReady = true;
    setDot(el.whisperDot, 'ok');
    el.whisperText.textContent = `Whisper: ${model.split('/').pop()}`;
    el.start.disabled = false;
    return result;
  } catch (error) {
    state.whisperReady = false;
    setDot(el.whisperDot, 'err');
    el.whisperText.textContent = 'Whisper: failed - click to retry';
    el.start.disabled = true;
    appendError(el.transcript, `Could not load the Whisper model: ${error.message}`);
    return null;
  }
}

window.speakai.whisper.onProgress((progress) => {
  if (!progress?.message) return;
  setDot(el.whisperDot, progress.status === 'ready' ? 'ok' : 'busy');
  const label = progress.status === 'downloading' ? 'Whisper: downloading' : 'Whisper: loading';
  el.whisperText.textContent = `${label}${progress.progress ? ` ${Math.round(progress.progress)}%` : ''}`;
});

/* ------------------------------------------------------------- ollama status */
async function refreshOllama() {
  el.ollamaText.textContent = 'Ollama: checking';
  setDot(el.ollamaDot, 'busy');
  const health = await window.speakai.ollama.health();

  if (!health.ok) {
    setDot(el.ollamaDot, 'err');
    el.ollamaText.textContent = 'Ollama: offline - click to retry';
    el.llmModel.innerHTML = '<option value="">(Ollama offline)</option>';
    return;
  }

  setDot(el.ollamaDot, 'ok');
  const models = await window.speakai.ollama.models();
  el.llmModel.innerHTML = '';
  if (!models.length) {
    el.llmModel.innerHTML = '<option value="">(no models - run ollama pull)</option>';
    el.ollamaText.textContent = 'Ollama: running, no models';
    return;
  }
  const names = models.map((model) => model.name).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    el.llmModel.append(option);
  }
  const preferred = store.get('llmModel', '');
  // models[0] is the smallest one on disk, a much safer default than alphabetical order.
  el.llmModel.value = names.includes(preferred) ? preferred : models[0].name;
  el.ollamaText.textContent = `Ollama: ${names.length} model${names.length > 1 ? 's' : ''}`;
  updateSuggestState();
}

/* ------------------------------------------------------------------ capture */
function onAudioFrame(frame) {
  if (!state.recording) return;

  el.level.style.width = `${Math.min(100, rms(frame) * 600)}%`;

  state.chunks.push(frame);
  state.pendingSamples += frame.length;

  if (state.pendingSamples >= CHUNK_SECONDS * SAMPLE_RATE) void flushAudio();
}

async function startCapture() {
  if (state.recording) return;
  el.start.disabled = true;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioContext.audioWorklet.addModule('audio-processor.js');

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'recorder-processor');
    workletNode.port.onmessage = (event) => onAudioFrame(event.data);

    // Silent sink keeps the worklet pulling audio without playing it back.
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    sourceNode.connect(workletNode);
    workletNode.connect(mute).connect(audioContext.destination);
  } catch (error) {
    el.start.disabled = false;
    appendError(el.transcript, `Microphone unavailable: ${error.message}`);
    return;
  }

  state.recording = true;
  state.startedAt = Date.now();
  state.chunks = [];
  state.pendingSamples = 0;

  el.start.disabled = true;
  el.stop.disabled = false;
  el.start.classList.add('is-recording');
  el.timerId = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    el.timer.textContent = `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  }, 500);
}

async function stopCapture() {
  if (!state.recording) return;
  state.recording = false;
  el.stop.disabled = true;
  el.start.disabled = false;
  el.start.classList.remove('is-recording');
  clearInterval(state.timerId);
  state.timerId = null;

  if (workletNode) workletNode.port.onmessage = null;
  if (sourceNode) sourceNode.disconnect();
  if (workletNode) workletNode.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  if (audioContext) await audioContext.close();

  audioContext = null;
  workletNode = null;
  sourceNode = null;
  mediaStream = null;
  el.level.style.width = '0%';

  await flushAudio({ force: true });
}

/* -------------------------------------------------------------- transcribe */
function addPendingLine() {
  clearPlaceholder(el.transcript);
  const line = document.createElement('p');
  line.className = 'entry partial';
  line.id = 'pending-line';
  line.textContent = 'Recognising...';
  el.transcript.append(line);
  scrollToBottom(el.transcript);
}

function removePendingLine() {
  document.getElementById('pending-line')?.remove();
}

async function flushAudio({ force = false } = {}) {
  if (!state.pendingSamples) return;
  const minSamples = (force ? 0.35 : MIN_CHUNK_SECONDS) * SAMPLE_RATE;
  if (state.pendingSamples < minSamples) {
    state.chunks = [];
    state.pendingSamples = 0;
    return;
  }

  const audio = concatChunks(state.chunks, state.pendingSamples);
  state.chunks = [];
  state.pendingSamples = 0;

  if (rms(audio) < SILENCE_RMS) return; // pure silence -> nothing to recognise
  if (!state.whisperReady) return;

  if (state.transcribing > 0) {
    // Whisper is busy: keep this audio for the next pass instead of dropping it.
    state.chunks.push(audio);
    state.pendingSamples = audio.length;
    return;
  }

  state.transcribing += 1;
  addPendingLine();

  try {
    const text = await window.speakai.whisper.transcribe(audio, el.language.value || null);
    removePendingLine();
    if (text) appendTranscript(text);
  } catch (error) {
    removePendingLine();
    appendError(el.transcript, `Transcription failed: ${error.message}`);
  } finally {
    state.transcribing -= 1;
    if (state.pendingSamples >= CHUNK_SECONDS * SAMPLE_RATE) void flushAudio();
  }
}

function appendTranscript(text) {
  clearPlaceholder(el.transcript);
  const entry = document.createElement('p');
  entry.className = 'entry';
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = '';
  const stamp = document.createElement('span');
  stamp.className = 'entry-time';
  stamp.textContent = time;
  const body = document.createElement('span');
  body.textContent = text;
  entry.append(stamp, body);
  el.transcript.append(entry);
  scrollToBottom(el.transcript);

  state.lastQuestion = text;
  updateSuggestState();

  if (el.autoSuggest.checked && looksLikeQuestion(text)) {
    const key = text.toLowerCase().trim();
    if (!state.autoAnswered.has(key) && !state.streamRequestId) {
      state.autoAnswered.add(key);
      void suggestAnswer();
    }
  }
}

function looksLikeQuestion(text) {
  const normalized = text.toLowerCase().trim();
  if (normalized.includes('?')) return true;
  return /^(what|why|how|when|where|who|which|can you|could you|do you|does|is|are|should|would|will|tell me|explain)\b/.test(
    normalized
  );
}

function transcriptText() {
  return Array.from(el.transcript.querySelectorAll('.entry:not(.partial) span:last-child'))
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join(' ');
}

function appendError(node, message) {
  clearPlaceholder(node);
  const line = document.createElement('p');
  line.className = 'entry error';
  line.textContent = message;
  node.append(line);
  scrollToBottom(node);
}

function updateSuggestState() {
  el.suggest.disabled = !transcriptText() || Boolean(state.streamRequestId);
}

/* ------------------------------------------------------------------ answer */
async function suggestAnswer() {
  const question = state.lastQuestion || transcriptText();
  if (!question || state.streamRequestId) return;
  const model = el.llmModel.value;
  if (!model) {
    appendError(el.answer, 'No Ollama model selected. Is Ollama running with at least one pulled model?');
    return;
  }

  clearPlaceholder(el.answer);
  el.answer.textContent = '';
  const body = document.createElement('span');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  el.answer.append(body, cursor);

  state.answerText = '';
  state.streamRequestId = crypto.randomUUID();
  el.suggest.disabled = true;
  el.abort.hidden = false;

  await window.speakai.ollama.suggest({
    requestId: state.streamRequestId,
    model,
    question,
    transcript: transcriptText(),
  });
}

function onToken({ requestId, token }) {
  if (requestId !== state.streamRequestId) return;
  state.answerText += token;
  const body = el.answer.querySelector('span:not(.cursor)');
  if (body) body.textContent = state.answerText;
  scrollToBottom(el.answer);
}

function finishStream() {
  el.answer.querySelector('.cursor')?.remove();
  state.streamRequestId = null;
  el.abort.hidden = true;
  updateSuggestState();
}

window.speakai.ollama.onToken(onToken);

window.speakai.ollama.onDone(({ requestId }) => {
  if (requestId !== state.streamRequestId) return;
  if (!state.answerText) {
    clearPlaceholder(el.answer);
    const line = document.createElement('p');
    line.className = 'entry placeholder';
    line.textContent = 'No answer was produced.';
    el.answer.append(line);
  }
  finishStream();
});

window.speakai.ollama.onError(({ requestId, message, hint }) => {
  if (requestId !== state.streamRequestId) return;
  el.answer.textContent = '';
  appendError(el.answer, `Ollama error: ${message}`);
  const help = document.createElement('p');
  help.className = 'hint';
  help.textContent =
    hint || 'Start the local server with "ollama serve" and install a model with "ollama pull llama3.2".';
  el.answer.append(help);
  finishStream();
});

/* ------------------------------------------------------------------ events */
el.start.addEventListener('click', () => {
  if (!state.whisperReady) {
    void loadWhisper(el.whisperModel.value).then(() => startCapture());
    return;
  }
  void startCapture();
});

el.stop.addEventListener('click', () => void stopCapture());

el.suggest.addEventListener('click', () => void suggestAnswer());

el.abort.addEventListener('click', () => {
  if (state.streamRequestId) void window.speakai.ollama.abort(state.streamRequestId);
});

el.clear.addEventListener('click', () => {
  el.transcript.innerHTML =
    '<p class="placeholder">Press <strong>Start</strong> and speak. Your words appear here as they are recognised - all on this machine.</p>';
  el.answer.innerHTML =
    '<p class="placeholder">Ask a question out loud, then press <strong>Suggest Answer</strong> to let your local LLM reply.</p>';
  state.lastQuestion = '';
  state.autoAnswered.clear();
  updateSuggestState();
});

el.whisperModel.addEventListener('change', () => {
  store.set('whisperModel', el.whisperModel.value);
  state.whisperReady = false;
  void loadWhisper(el.whisperModel.value);
});

el.language.addEventListener('change', () => store.set('language', el.language.value));

el.llmModel.addEventListener('change', () => {
  store.set('llmModel', el.llmModel.value);
  updateSuggestState();
});

el.autoSuggest.addEventListener('change', () => store.set('autoSuggest', el.autoSuggest.checked ? '1' : '0'));

el.whisperDot.closest('button').addEventListener('click', () => {
  if (!state.recording) void loadWhisper(el.whisperModel.value);
});

el.ollamaDot.closest('button').addEventListener('click', () => void refreshOllama());

/* -------------------------------------------------------------------- init */
(async function init() {
  const savedWhisper = store.get('whisperModel', '');
  if (savedWhisper && [...el.whisperModel.options].some((option) => option.value === savedWhisper)) {
    el.whisperModel.value = savedWhisper;
  }
  el.language.value = store.get('language', '');
  el.autoSuggest.checked = store.get('autoSuggest', '1') === '1';

  try {
    const info = await window.speakai.info();
    el.footerInfo.textContent = `SpeakAI v${info.version} - Electron ${info.electron} - Ollama ${info.ollamaHost}`;
  } catch {
    /* non critical */
  }

  void loadWhisper(el.whisperModel.value);
  void refreshOllama();
})();
