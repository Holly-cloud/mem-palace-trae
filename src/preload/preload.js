'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memPalace', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  pathExists: (p) => ipcRenderer.invoke('path:exists', p),
  auditSources: (p) => ipcRenderer.invoke('audit:sources', p),
  auditPalace: (p) => ipcRenderer.invoke('audit:palace', p),
  testLlm: (overrides) => ipcRenderer.invoke('llm:test', overrides),
  startConversion: (payload) => ipcRenderer.invoke('convert:start', payload),
  stopConversion: () => ipcRenderer.invoke('convert:stop'),
  readIndex: (dir) => ipcRenderer.invoke('palace:readIndex', dir),
  inbox: (dir) => ipcRenderer.invoke('palace:inbox', dir),
  acceptCard: (dir, id) => ipcRenderer.invoke('card:accept', { dir, id }),
  discardCard: (dir, id) => ipcRenderer.invoke('card:discard', { dir, id }),
  reindex: (dir) => ipcRenderer.invoke('palace:reindex', dir),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  onProgress: (cb) => {
    ipcRenderer.on('convert:progress', (_e, data) => cb(data));
  },
});