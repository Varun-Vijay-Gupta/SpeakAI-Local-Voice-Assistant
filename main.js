'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');

const whisper = require('./src/whisper');
const ollama = require('./src/ollama');

app.setName('SpeakAI');

let mainWindow = null;
const activeStreams = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1116',
    title: 'SpeakAI - Local Voice Assistant',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function configurePermissions() {
  const allowed = new Set(['media', 'audioCapture', 'microphone']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    cacheDir: whisper.getCacheDir(),
    ollamaHost: ollama.host(),
  }));

  // ---------------------------------------------------------------- Whisper
  ipcMain.handle('whisper:load', async (event, { model }) => {
    const sender = event.sender;
    return whisper.load(model, (progress) => {
      if (!sender.isDestroyed()) sender.send('whisper:progress', progress);
    });
  });

  ipcMain.handle('whisper:transcribe', async (_event, { audio, language }) =>
    whisper.transcribe(audio, { language })
  );

  // ----------------------------------------------------------------- Ollama
  ipcMain.handle('ollama:health', () => ollama.health());
  ipcMain.handle('ollama:models', () => ollama.listModels());

  ipcMain.handle('ollama:suggest', async (event, payload) => {
    const { requestId } = payload;
    const sender = event.sender;
    const controller = new AbortController();
    activeStreams.set(requestId, controller);

    try {
      const text = await ollama.streamAnswer({
        ...payload,
        signal: controller.signal,
        onToken: (token) => {
          if (!sender.isDestroyed()) sender.send('ollama:token', { requestId, token });
        },
      });
      if (!sender.isDestroyed()) sender.send('ollama:done', { requestId, text });
      return { ok: true };
    } catch (error) {
      const aborted = error.name === 'AbortError';
      if (!sender.isDestroyed()) {
        if (aborted) sender.send('ollama:done', { requestId, aborted: true, text: '' });
        else sender.send('ollama:error', { requestId, message: error.message, hint: error.hint });
      }
      return { ok: false, message: error.message };
    } finally {
      activeStreams.delete(requestId);
    }
  });

  ipcMain.handle('ollama:abort', (_event, { requestId }) => {
    const controller = activeStreams.get(requestId);
    if (controller) controller.abort();
    return { ok: Boolean(controller) };
  });
}

app.whenReady().then(() => {
  whisper.setCacheDir(path.join(app.getPath('userData'), 'models'));
  configurePermissions();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const controller of activeStreams.values()) controller.abort();
  if (process.platform !== 'darwin') app.quit();
});
