'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Local speech-to-text with Whisper.
 *
 * The model runs fully on this machine through Transformers.js (ONNX Runtime).
 * Weights are downloaded once into the app cache directory and are then reused
 * offline forever after - no audio ever leaves the computer.
 */

const DEFAULT_MODEL = 'onnx-community/whisper-base';

let cacheDir = path.join(process.cwd(), '.models');
let transformersPromise = null;
let transcriber = null;
let loadedModel = null;
let loadingPromise = null;
let loadingModel = null;

function setCacheDir(dir) {
  cacheDir = dir;
  fs.mkdirSync(path.join(cacheDir, 'whisper'), { recursive: true });
}

function getCacheDir() {
  return path.join(cacheDir, 'whisper');
}

async function getTransformers() {
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers').then((mod) => {
      // Keep every model artifact on disk so later runs work without network.
      mod.env.cacheDir = getCacheDir();
      mod.env.allowLocalModels = true;
      mod.env.allowRemoteModels = true;
      mod.env.useFSCache = true;
      return mod;
    });
  }
  return transformersPromise;
}

function isReady() {
  return Boolean(transcriber);
}

function currentModel() {
  return loadedModel;
}

function isSameModelInstalled(model) {
  const folder = path.join(getCacheDir(), model);
  return fs.existsSync(path.join(folder, 'config.json'));
}

/**
 * Load (downloading on first use) a Whisper model.
 * @param {string} model Hugging Face repo id of the ONNX Whisper model.
 * @param {(progress: object) => void} [onProgress]
 */
async function load(model = DEFAULT_MODEL, onProgress) {
  if (transcriber && loadedModel === model) {
    return { model, ready: true, cached: true };
  }
  if (loadingPromise && loadingModel === model) return loadingPromise;

  loadingModel = model;
  loadingPromise = (async () => {
    const { pipeline } = await getTransformers();
    const cached = isSameModelInstalled(model);
    onProgress?.({
      status: cached ? 'loading' : 'downloading',
      message: cached ? `Loading ${model} from disk...` : `Downloading ${model} (first run only)...`,
      cached,
    });

    const encoder = await pipeline('automatic-speech-recognition', model, {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
      progress_callback: (progress) => {
        if (progress.status === 'progress' && progress.file) {
          onProgress?.({
            status: 'downloading',
            file: progress.file,
            progress: progress.progress ?? 0,
            message: `Downloading ${progress.file} - ${Math.round(progress.progress ?? 0)}%`,
          });
        }
      },
    });

    transcriber = encoder;
    loadedModel = model;
    onProgress?.({ status: 'ready', message: `${model} ready`, model });
    return { model, ready: true, cached };
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
    loadingModel = null;
  }
}

function toFloat32Array(audio) {
  if (audio instanceof Float32Array) return audio;
  if (audio?.buffer instanceof ArrayBuffer) return new Float32Array(audio.buffer, audio.byteOffset, audio.byteLength / 4);
  if (audio instanceof ArrayBuffer) return new Float32Array(audio);
  if (Array.isArray(audio)) return Float32Array.from(audio);
  throw new TypeError('Unsupported audio payload; expected Float32 PCM samples.');
}

/**
 * Transcribe mono 16 kHz float PCM samples.
 * @param {Float32Array|ArrayBuffer} audio
 * @param {{ language?: string | null }} [options]
 * @returns {Promise<string>}
 */
async function transcribe(audio, options = {}) {
  if (!transcriber) throw new Error('Whisper is not loaded yet. Wait for the model status to turn green.');

  const samples = toFloat32Array(audio);
  if (samples.length < 1600) return ''; // < 0.1s of audio, nothing to do

  const input = { chunk_length_s: 30, stride_length_s: 5 };
  if (options.language) input.language = options.language;
  else input.language = null; // auto-detect

  const result = await transcriber(samples, input);
  return (result?.text || '').trim();
}

module.exports = {
  DEFAULT_MODEL,
  setCacheDir,
  getCacheDir,
  isReady,
  currentModel,
  load,
  transcribe,
};
