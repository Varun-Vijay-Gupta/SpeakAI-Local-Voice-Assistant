'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('speakai', {
  info: () => ipcRenderer.invoke('app:info'),

  whisper: {
    load: (model) => ipcRenderer.invoke('whisper:load', { model }),
    transcribe: (audio, language) => ipcRenderer.invoke('whisper:transcribe', { audio, language }),
    onProgress: (handler) => subscribe('whisper:progress', handler),
  },

  ollama: {
    health: () => ipcRenderer.invoke('ollama:health'),
    models: () => ipcRenderer.invoke('ollama:models'),
    suggest: (payload) => ipcRenderer.invoke('ollama:suggest', payload),
    abort: (requestId) => ipcRenderer.invoke('ollama:abort', { requestId }),
    onToken: (handler) => subscribe('ollama:token', handler),
    onDone: (handler) => subscribe('ollama:done', handler),
    onError: (handler) => subscribe('ollama:error', handler),
  },
});
