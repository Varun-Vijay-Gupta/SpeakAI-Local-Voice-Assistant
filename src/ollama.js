'use strict';

/**
 * Local LLM answers through Ollama (http://localhost:11434 by default).
 * Everything stays on this machine - Ollama is a local server, not a cloud API.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2';

// Spoken questions are short, so a small context window is plenty - and it keeps
// the KV cache (a big part of the RAM a model needs) as small as possible.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 2048;

const SYSTEM_PROMPT = [
  'You are a concise, helpful assistant sitting next to the user.',
  'The user speaks their question out loud and you receive the raw speech-to-text transcript,',
  'which may contain small recognition errors, missing punctuation or filler words.',
  'Infer the intended question, then answer it directly.',
  'Rules: start with the answer itself (no preamble, no repeating the question);',
  'keep it short and skimmable - a few sentences or a tight bullet list;',
  'use plain text with simple "-" bullets and no markdown headings;',
  'if the transcript is unintelligible, say so and ask one short clarifying question.',
].join(' ');

function host() {
  return (process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/+$/, '');
}

async function request(pathname, options = {}) {
  const response = await fetch(`${host()}${pathname}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

async function health() {
  try {
    const response = await request('/api/tags');
    const data = await response.json();
    return { ok: true, models: (data.models || []).map((model) => model.name) };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function listModels() {
  const response = await request('/api/tags');
  const data = await response.json();
  return (data.models || [])
    .filter((model) => model.name)
    .map((model) => ({ name: model.name, size: model.size || 0 }))
    .sort((a, b) => a.size - b.size); // smallest first - the safest default on low-RAM machines
}

function buildMessages({ question, transcript }) {
  const trimmedQuestion = (question || '').trim();
  const trimmedTranscript = (transcript || '').trim();
  const context =
    trimmedTranscript && trimmedTranscript !== trimmedQuestion
      ? `Full conversation transcript so far (the question is the last thing asked):\n"""\n${trimmedTranscript}\n"""\n\n`
      : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${context}Question: ${trimmedQuestion || trimmedTranscript}` },
  ];
}

/**
 * Turn a failed Ollama response into an error carrying an actionable `hint`
 * for the UI. The out-of-memory case is common on machines with little free RAM.
 */
async function buildRequestError(response, model) {
  const detail = await response.text();
  let message = `Ollama request failed (${response.status}).`;
  try {
    message = JSON.parse(detail).error || message;
  } catch {
    if (detail) message = `Ollama request failed (${response.status}): ${detail}`;
  }

  const error = new Error(message);
  if (response.status === 404) {
    error.hint = `Run "ollama pull ${model}" and reopen the app.`;
  } else if (/memory|out of memory|ram/i.test(message)) {
    error.hint =
      `"${model}" needs more RAM than is currently free. Close other apps, or pull a smaller model ` +
      '(for example "ollama pull qwen2.5:0.5b") and select it in the Ollama model dropdown.';
  }
  return error;
}

/**
 * Stream an answer token by token.
 * @param {object} options
 * @param {string} options.model
 * @param {string} options.question
 * @param {string} [options.transcript]
 * @param {AbortSignal} [options.signal]
 * @param {(token: string) => void} [options.onToken]
 * @returns {Promise<string>} the full answer
 */
async function streamAnswer({ model = DEFAULT_MODEL, question, transcript, signal, onToken }) {
  const response = await fetch(`${host()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: '10m',
      messages: buildMessages({ question, transcript }),
      options: { temperature: 0.3, num_predict: 512, num_ctx: NUM_CTX },
    }),
  });

  if (!response.ok) {
    throw await buildRequestError(response, model);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // ignore partial/corrupt line
      }
      if (message.error) throw new Error(message.error);

      const token = message.message?.content;
      if (token) {
        answer += token;
        onToken?.(token);
      }
    }
  }

  return answer.trim();
}

module.exports = { DEFAULT_MODEL, host, health, listModels, streamAnswer };
