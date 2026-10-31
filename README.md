# SpeakAI — Local Voice Assistant

A minimal Windows desktop app (Electron + plain JavaScript) that listens to your microphone,
transcribes your speech **on your own machine** with Whisper, and asks a **local** LLM
(via [Ollama](https://ollama.com)) for an answer that streams into the UI word by word.

Inspired by Parakeet AI, but 100% offline: no cloud APIs, no API keys, no audio ever leaving the computer.

```
┌──────────────────────────────────────────────────────────────┐
│  SpeakAI                                  ● Whisper  ● Ollama │
├──────────────────────────────────────────────────────────────┤
│  [● Start] [■ Stop]  ▓▓▓▓░░░░  00:07        models ▾ ▾ ▾     │
├───────────────────────────────┬──────────────────────────────┤
│  Transcript                   │  Suggested answer            │
│  12:01:04  What is the        │  A closure is a function     │
│            difference between │  that keeps a reference to…  │
│  ...                          │  ▌ (streaming)               │
└───────────────────────────────┴──────────────────────────────┘
```

## Features

- **Start / Stop** buttons capture microphone audio (16 kHz mono PCM).
- **Live transcription** — audio is cut into ~4 s blocks and transcribed by Whisper while you speak.
- **Suggest Answer** — sends the transcribed question to a local Ollama model and renders the reply
  **progressively** as tokens stream in.
- **Optional "Auto answer"** — automatically asks the LLM whenever a spoken sentence looks like a question.
- Model pickers for both Whisper (tiny / base / small, multilingual or English-only) and Ollama models
  (auto-discovered from your local install), plus a language selector.
- Level meter, recording timer, transcript timestamps, and clear status indicators.
- Clean, minimal dark UI.

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Windows 10/11 | macOS/Linux work too, but this guide targets Windows |
| [Node.js 18+](https://nodejs.org) | verified with Node 22 |
| [Ollama for Windows](https://ollama.com/download) | runs the local LLM server on `127.0.0.1:11434` |
| A microphone | any built-in or USB mic |

## 2. Install the app

```powershell
cd "C:\Users\vg958\OneDrive\Documents\College\Coding\SpeakAI – Local Voice Assistant"
npm install
```

## 3. Set up the local LLM (Ollama)

```powershell
ollama pull llama3.2        # ~2 GB, good default. qwen2.5:7b / mistral also work
ollama serve                # only needed if Ollama isn't already running in the tray
```

Check it is alive from a browser or PowerShell:

```powershell
curl http://127.0.0.1:11434/api/tags
```

The app auto-detects every model you have pulled and lists them in the **Ollama model** dropdown.

## 4. Run

```powershell
npm start
```

On the first launch the Whisper weights are downloaded **once** from Hugging Face into

```
%APPDATA%\SpeakAI\models\whisper\onnx-community\whisper-base
```

`whisper-base` needs roughly 150–200 MB. After that download the app works completely offline —
the status chip in the top-right shows live progress, and speech recognition never touches the network.

> Prefer to stay offline from the very first run? Copy a model folder (e.g. `onnx-community/whisper-base`)
> into `%APPDATA%\SpeakAI\models\whisper\` before starting the app — the local copy is used as-is.
> Note that Ollama models are also stored locally, so pulling them once is all you need.

## 5. Use it

1. Press **Start** — the level meter should move when you talk.
2. Speak your question. Recognised text appears in the left panel a few seconds at a time.
3. Press **Suggest Answer** (or tick **Auto answer**) — the local model's reply streams into the right panel.
4. Press **Stop** to end capture, **Stop** in the answer panel to abort a running generation, **Clear** to reset.

## How it works

| Layer | File | Role |
| --- | --- | --- |
| Main process | [main.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/main.js) | Window, microphone permission handler, IPC bridge, stream lifecycle |
| Whisper | [src/whisper.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/src/whisper.js) | Loads Whisper via Transformers.js (ONNX Runtime, CPU) and transcribes float PCM |
| Ollama | [src/ollama.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/src/ollama.js) | Talks to `localhost:11434`, parses the streaming NDJSON response |
| Preload | [preload.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/preload.js) | Exposes a narrow `window.speakai` API (`contextIsolation` on, `nodeIntegration` off) |
| Renderer | [renderer/renderer.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/renderer/renderer.js) | Mic capture, chunking, transcript + streaming answer UI |
| Audio worklet | [renderer/audio-processor.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/renderer/audio-processor.js) | Raw PCM frames at 16 kHz |

Audio path: `getUserMedia → AudioContext(16 kHz) → AudioWorklet → Float32 chunks → IPC → Whisper → UI`.
Answer path: `transcript → IPC → Ollama /api/chat (stream) → token events → UI`.

## Configuration

| Setting | Where |
| --- | --- |
| Whisper model | dropdown in the toolbar (stored in `localStorage`) |
| Recognition language | dropdown in the toolbar, or *Auto detect* |
| Ollama model | dropdown in the toolbar, populated from `/api/tags` |
| Ollama URL | environment variable `OLLAMA_HOST`, default `http://127.0.0.1:11434` |
| Chunk size / silence threshold | constants at the top of [renderer.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/renderer/renderer.js) |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Whisper: failed` | Check the internet connection for the first download, or place the model folder in `%APPDATA%\SpeakAI\models\whisper` and click the chip to retry. |
| `Ollama: offline` | Start Ollama (`ollama serve`) and click the **Ollama** chip to re-check. |
| `Model "x" is not installed` | `ollama pull x`, then reopen the app. |
| `model requires more system memory (… GiB) than is available` | The model is too big for the free RAM on this machine. Close other applications, and/or pull a small model: `ollama pull qwen2.5:0.5b` (~0.4 GB), `ollama pull llama3.2:1b` (~1.3 GB), then select it in the **Ollama model** dropdown. The app already asks for a small 2048-token context to keep RAM usage down. |
| `Microphone unavailable` | Windows *Settings → Privacy → Microphone* must allow desktop apps. |
| Transcription is slow | Pick `whisper-tiny`, or switch language from *Auto detect* to a fixed language. |
| Words get cut between blocks | Speak in sentences; increase `CHUNK_SECONDS` in [renderer.js](file:///c:/Users/vg958/OneDrive/Documents/College/Coding/SpeakAI%20–%20Local%20Voice%20Assistant/renderer/renderer.js) for fewer, longer blocks (higher latency). |

## Notes & limitations

- Transcription is chunk-based (~4 s), so a word straddling a boundary can be split — the trade-off
  for streaming output with a local model and no GPU.
- Whisper runs on the CPU through ONNX Runtime; `whisper-base` is a good balance, `whisper-small`
  is noticeably slower but more accurate.
- The app talks to `127.0.0.1` only. There is no telemetry and no external network call after the
  one-time model download.
