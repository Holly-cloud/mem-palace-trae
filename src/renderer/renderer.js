'use strict';

const api = window.memPalace;
const el = (id) => document.getElementById(id);

const state = {
  config: null,
  sourcePath: '',
  outputDir: '',
  running: false,
};

// ---------- 工具 ----------

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(message, kind = 'info') {
  const box = el('toast');
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === 'error' ? 6000 : 3000);
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- 标签页 ----------

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.id === `panel-${tab.dataset.panel}`);
      });
      if (tab.dataset.panel === 'review') refreshInbox();
      if (tab.dataset.panel === 'index') refreshIndex();
    });
  });
}

// ---------- 设置 ----------

const PLACEHOLDER = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434',
  mock: '（离线启发式，无需填写）',
};

function fillSetup(cfg) {
  el('provider').value = cfg.provider || 'openai';
  el('baseUrl').value = cfg.baseUrl || '';
  el('apiKey').value = cfg.apiKey || '';
  el('model').value = cfg.model || '';
  el('defaultScope').value = cfg.defaultScope || 'user';
  el('maxChars').value = cfg.maxChars || 4000;
  syncProviderFields();
  updateStatusChip(cfg);
}

function syncProviderFields() {
  const provider = el('provider').value;
  el('baseUrl').placeholder = PLACEHOLDER[provider] || '';
  const offline = provider === 'mock';
  el('baseUrl').disabled = offline;
  el('apiKey').disabled = offline;
  el('model').disabled = offline;
  if (offline) {
    el('baseUrl').value = '';
    el('apiKey').value = '';
    el('model').value = 'mock-heuristic';
  } else if (!el('model').value) {
    el('model').value = provider === 'ollama' ? 'qwen2.5:7b' : 'gpt-4o-mini';
  }
}

function updateStatusChip(cfg) {
  if (!cfg) return;
  el('statusChip').textContent = cfg.provider === 'mock'
    ? '离线启发式（无 LLM）'
    : `${cfg.provider === 'ollama' ? 'Ollama' : 'OpenAI 兼容'} · ${cfg.model || '(未设模型)'}`;
}

function readSetup() {
  return {
    provider: el('provider').value,
    baseUrl: el('baseUrl').value.trim(),
    apiKey: el('apiKey').value.trim(),
    model: el('model').value.trim(),
    defaultScope: el('defaultScope').value,
    maxChars: Number(el('maxChars').value) || 4000,
  };
}

async function saveSetup(silent) {
  state.config = await api.setConfig(readSetup());
  updateStatusChip(state.config);
  if (!silent) toast('设置已保存');
  return state.config;
}

function bindSetup() {
  el('provider').addEventListener('change', syncProviderFields);
  el('saveConfig').addEventListener('click', () => saveSetup(false));
  el('testLlm').addEventListener('click', async () => {
    const box = el('testResult');
    box.hidden = false;
    box.textContent = '测试中…';
    try {
      const res = await api.testLlm(readSetup());
      box.textContent = `连接正常\nprovider=${res.provider}  model=${res.model}\n返回：${res.reply}`;
      toast('连接正常');
    } catch (err) {
      box.textContent = `连接失败：${err.message}`;
      toast(`连接失败：${err.message}`, 'error');
    }
  });
}

// ---------- 转换 ----------

function bindConvert() {
  el('pickSourceDir').addEventListener('click', async () => {
    const p = await api.pickDir();
    if (p) { state.sourcePath = p; el('sourcePath').value = p; }
  });
  el('pickSourceFile').addEventListener('click', async () => {
    const p = await api.pickFile();
    if (p) { state.sourcePath = p; el('sourcePath').value = p; }
  });
  el('pickOutputDir').addEventListener('click', async () => {
    const p = await api.pickDir();
    if (p) { state.outputDir = p; el('outputDir').value = p; }
  });
  el('sourcePath').addEventListener('change', (e) => { state.sourcePath = e.target.value.trim(); });
  el('outputDir').addEventListener('change', (e) => { state.outputDir = e.target.value.trim(); });

  el('auditSources').addEventListener('click', runAudit);
  el('startConversion').addEventListener('click', startConversion);
  el('stopConversion').addEventListener('click', async () => {
    await api.stopConversion();
    toast('已请求停止，当前块处理完后会保存进度');
  });
}

async function runAudit() {
  const source = state.sourcePath || el('sourcePath').value.trim();
  if (!source) { toast('请先选择来源', 'error'); return; }
  try {
    const a = await api.auditSources(source);
    const lines = [
      `来源：${a.root}`,
      `文件数：${a.fileCount}　总大小：${formatBytes(a.totalBytes)}`,
      `类型分布：${Object.entries(a.byKind).map(([k, v]) => `${k} ${v}`).join('　') || '-'}`,
      `预计分块：${a.estChunks}`,
      `超大跳过：${a.oversized}　重复文件：${a.duplicateCount}`,
    ];
    if (a.duplicates.length) {
      lines.push('', '重复文件示例：', ...a.duplicates.slice(0, 8).map((d) => `  ${d.path}  ==  ${d.duplicateOf}`));
    }
    const box = el('auditResult');
    box.textContent = lines.join('\n');
    box.hidden = false;
    toast('来源体检完成');
  } catch (err) {
    toast(`体检失败：${err.message}`, 'error');
  }
}

const STAT_DEFS = [
  ['文件', 'files'], ['分块', 'chunks'], ['跳过块', 'skippedChunks'], ['候选', 'candidates'],
  ['新增', 'added'], ['更新', 'updated'], ['取代', 'superseded'], ['合并', 'merged'],
  ['待裁决', 'escalated'], ['忽略', 'noop'], ['失败', 'failed'],
];

function renderStats(stats) {
  const s = stats || {};
  el('statGrid').innerHTML = STAT_DEFS.map(([label, key]) => (
    `<div class="stat"><span class="label">${label}</span><span class="value">${Number(s[key]) || 0}</span></div>`
  )).join('');
}

function renderWarnings(warnings) {
  const list = warnings || [];
  el('warnCount').textContent = String(list.length);
  el('warnBox').hidden = list.length === 0;
  el('warnings').innerHTML = list.slice(0, 200).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
}

function onProgress(data) {
  const { phase, fileIndex = 0, fileTotal = 0, fileRelPath, chunkIndex, chunkTotal } = data;
  if (data.stats) {
    renderStats(data.stats);
    renderWarnings(data.stats.warnings);
  }

  let pct = 0;
  if (fileTotal) {
    pct = chunkTotal
      ? (((fileIndex - 1) + (chunkIndex || 0) / chunkTotal) / fileTotal) * 100
      : (fileIndex / fileTotal) * 100;
  }
  if (phase === 'done') pct = 100;
  el('progressBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;

  const phaseText = { scan: '扫描来源…', converting: '转换中…', indexing: '生成索引…', done: '完成' }[phase] || phase;
  el('progressText').textContent = [
    phaseText,
    `文件 ${fileIndex}/${fileTotal}`,
    fileRelPath ? `· ${fileRelPath}` : '',
    chunkTotal ? `· 块 ${chunkIndex || 0}/${chunkTotal}` : '',
  ].filter(Boolean).join('　');
}

async function startConversion() {
  if (state.running) return;
  const sourcePath = state.sourcePath || el('sourcePath').value.trim();
  const outputDir = state.outputDir || el('outputDir').value.trim();
  if (!sourcePath) { toast('请先选择来源', 'error'); return; }
  if (!outputDir) { toast('请先选择输出目录', 'error'); return; }

  await saveSetup(true);
  state.running = true;
  el('startConversion').disabled = true;
  el('stopConversion').disabled = false;
  el('auditResult').hidden = true;
  el('progressBar').style.width = '0%';
  el('progressText').textContent = '启动中…';

  try {
    const result = await api.startConversion({
      sourcePath,
      outputDir,
      provider: state.config.provider,
      baseUrl: state.config.baseUrl,
      apiKey: state.config.apiKey,
      model: state.config.model,
      options: {
        defaultScope: state.config.defaultScope,
        maxChars: state.config.maxChars,
        resume: el('resume').checked,
      },
    });
    renderStats(result.stats);
    renderWarnings(result.stats.warnings);
    el('progressBar').style.width = '100%';
    el('progressText').textContent = result.stopped ? '已停止（再次开始即可续跑）' : '转换完成';
    toast(result.stopped
      ? '已停止，进度已保存'
      : `转换完成：新增 ${result.stats.added}，取代 ${result.stats.superseded}，待裁决 ${result.stats.escalated}`);
    state.outputDir = outputDir;
    await refreshIndex();
    await refreshInbox();
  } catch (err) {
    el('progressText').textContent = '转换失败';
    toast(`转换失败：${err.message}`, 'error');
  } finally {
    state.running = false;
    el('startConversion').disabled = false;
    el('stopConversion').disabled = true;
  }
}

// ---------- 审阅 ----------

async function refreshInbox() {
  const dir = state.outputDir || el('outputDir').value.trim();
  const list = el('inboxList');
  if (!dir) {
    el('inboxBadge').textContent = '0';
    list.innerHTML = '<div class="empty">请先在「转换」页选择输出目录</div>';
    return;
  }
  try {
    const items = await api.inbox(dir);
    el('inboxBadge').textContent = String(items.length);
    if (!items.length) {
      list.innerHTML = '<div class="empty">暂无待裁决记忆</div>';
      return;
    }
    list.innerHTML = items.map((item) => {
      const tags = (item.card.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ');
      return `<div class="card" data-id="${escapeHtml(item.card.id)}">
        <div class="meta">
          <span class="id">${escapeHtml(item.card.id)}</span>
          <span>${escapeHtml(item.card.type)} · ${escapeHtml(item.card.scope)}</span>
          <span>confidence ${item.card.confidence}</span>
          <span>来源 ${escapeHtml(item.card.source || '-')}</span>
          ${tags}
        </div>
        <p class="body">${escapeHtml(item.body)}</p>
        <div class="card-actions">
          <button class="btn primary" data-action="accept">采纳</button>
          <button class="btn danger" data-action="discard">丢弃</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

function bindReview() {
  el('refreshInbox').addEventListener('click', refreshInbox);
  el('inboxList').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const cardEl = btn.closest('.card');
    const id = cardEl.dataset.id;
    const dir = state.outputDir || el('outputDir').value.trim();
    try {
      btn.disabled = true;
      if (btn.dataset.action === 'accept') await api.acceptCard(dir, id);
      else await api.discardCard(dir, id);
      toast(btn.dataset.action === 'accept' ? '已采纳' : '已丢弃并归档');
      await refreshInbox();
    } catch (err) {
      btn.disabled = false;
      toast(`操作失败：${err.message}`, 'error');
    }
  });
}

// ---------- 索引 ----------

async function refreshIndex() {
  const dir = state.outputDir || el('outputDir').value.trim();
  if (!dir) return;
  try {
    const { catalog, health } = await api.readIndex(dir);
    el('catalogOut').textContent = catalog || '（暂无 CATALOG.md，先运行一次转换）';
    el('healthOut').textContent = health || '（暂无 HEALTH.md）';
  } catch (err) {
    toast(`读取索引失败：${err.message}`, 'error');
  }
}

function bindIndex() {
  el('refreshIndex').addEventListener('click', refreshIndex);
  el('reindex').addEventListener('click', async () => {
    const dir = state.outputDir || el('outputDir').value.trim();
    if (!dir) { toast('请先选择输出目录', 'error'); return; }
    try {
      const { t0 } = await api.reindex(dir);
      el('t0Out').textContent = t0 || '—';
      await refreshIndex();
      toast('索引已重建');
    } catch (err) {
      toast(`重建失败：${err.message}`, 'error');
    }
  });
  el('openOutput').addEventListener('click', async () => {
    const dir = state.outputDir || el('outputDir').value.trim();
    if (!dir) { toast('请先选择输出目录', 'error'); return; }
    await api.openPath(dir);
  });
}

// ---------- 启动 ----------

async function init() {
  bindTabs();
  bindSetup();
  bindConvert();
  bindReview();
  bindIndex();
  api.onProgress(onProgress);
  renderStats({});

  try {
    state.config = await api.getConfig();
    fillSetup(state.config);
    if (state.config.sourcePath) { state.sourcePath = state.config.sourcePath; el('sourcePath').value = state.config.sourcePath; }
    if (state.config.outputDir) { state.outputDir = state.config.outputDir; el('outputDir').value = state.config.outputDir; }
    await refreshInbox();
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);