'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const core = require('../core');

let mainWindow = null;
let runningJob = null;

// ---------- 配置持久化 ----------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const DEFAULT_CONFIG = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  defaultScope: 'user',
  maxChars: 4000,
  sourcePath: '',
  outputDir: '',
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let config = DEFAULT_CONFIG;

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

function providerFromConfig(overrides = {}) {
  return core.llm.createProvider({
    provider: overrides.provider || config.provider,
    baseUrl: overrides.baseUrl || config.baseUrl,
    apiKey: overrides.apiKey || config.apiKey,
    model: overrides.model || config.model,
    timeoutMs: 120000,
  });
}

// ---------- 窗口 ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'Memory Palace Converter',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('config:get', () => config);

  ipcMain.handle('config:set', (_e, patch) => {
    config = { ...config, ...(patch || {}) };
    if (config.maxChars) config.maxChars = Number(config.maxChars) || 4000;
    saveConfig();
    return config;
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: '文本记忆文件', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'csv', 'log'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('path:exists', (_e, p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });

  ipcMain.handle('audit:sources', (_e, p) => core.audit.auditSources(p, { maxChars: config.maxChars }));

  ipcMain.handle('audit:palace', (_e, p) => core.audit.auditPalace(p));

  ipcMain.handle('llm:test', async (_e, overrides) => {
    const provider = providerFromConfig(overrides || {});
    const reply = await provider.complete({
      system: 'You are a connectivity probe.',
      user: 'Reply with the single word: ok',
      task: 'extract',
      meta: { chunkText: 'connectivity probe ok' },
    });
    return { provider: provider.name, model: provider.model, reply: String(reply).slice(0, 200) };
  });

  ipcMain.handle('convert:start', async (_e, payload) => {
    if (runningJob) throw new Error('已有转换任务在运行');
    const { sourcePath, outputDir, options = {} } = payload || {};
    if (!sourcePath || !outputDir) throw new Error('请先选择来源与输出目录');

    const provider = providerFromConfig(payload);
    runningJob = { stopped: false };

    const onProgress = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('convert:progress', data);
    };

    try {
      const result = await core.runConversion({
        sourcePath,
        outputDir,
        provider,
        options: {
          defaultScope: options.defaultScope || config.defaultScope,
          maxChars: Number(options.maxChars) || config.maxChars,
          resume: options.resume !== false,
        },
        onProgress,
        shouldStop: () => (runningJob ? runningJob.stopped : true),
      });
      config.sourcePath = sourcePath;
      config.outputDir = outputDir;
      saveConfig();
      return result;
    } finally {
      runningJob = null;
    }
  });

  ipcMain.handle('convert:stop', () => {
    if (runningJob) runningJob.stopped = true;
    return true;
  });

  ipcMain.handle('palace:readIndex', (_e, dir) => {
    const read = (name) => {
      try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; }
    };
    return { catalog: read('CATALOG.md'), health: read('HEALTH.md') };
  });

  ipcMain.handle('palace:inbox', (_e, dir) => {
    const items = core.store.readAllCards(dir);
    return items
      .filter((i) => i.card.status === 'pending-review')
      .map((i) => ({ card: i.card, body: i.body }));
  });

  ipcMain.handle('card:accept', (_e, { dir, id }) => core.store.acceptCard(dir, id));

  ipcMain.handle('card:discard', (_e, { dir, id }) => core.store.discardCard(dir, id));

  ipcMain.handle('palace:reindex', (_e, dir) => {
    const items = core.store.readAllCards(dir);
    const index = core.store.rebuildIndex(dir, items, { persistDecay: true });
    return { t0: index.t0 };
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
}

// ---------- 生命周期 ----------

app.whenReady().then(() => {
  config = loadConfig();
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});