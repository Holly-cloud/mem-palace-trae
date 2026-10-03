'use strict';

/** 校验 GUI 接线一致性：renderer 引用的 DOM id / preload API 必须真实存在。 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const preloadFile = path.join(__dirname, '..', 'src', 'preload', 'preload.js');

const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(preloadFile, 'utf8');

test('renderer 引用的 DOM id 全部存在于 index.html', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = [...new Set([...js.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = usedIds.filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `缺失的 DOM id: ${missing.join(', ')}`);
  assert.ok(usedIds.length > 20, '应检查到足量 id');
});

test('renderer 调用的 preload API 全部已暴露', () => {
  const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  const used = [...new Set([...js.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]))];
  const missing = used.filter((name) => !exposed.has(name));
  assert.deepEqual(missing, [], `preload 未暴露: ${missing.join(', ')}`);
});

test('主进程注册的 IPC 通道与 preload 调用一致', () => {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const handled = new Set([...mainJs.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]));
  const missing = [...invoked].filter((ch) => !handled.has(ch));
  assert.deepEqual(missing, [], `主进程未注册的通道: ${missing.join(', ')}`);
  assert.ok(handled.size >= 10, `通道数量偏少: ${handled.size}`);
});