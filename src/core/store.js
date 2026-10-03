'use strict';

/**
 * 记忆宫殿读写：卡片落盘、状态迁移、事件日志、以及索引/健康报告生成。
 * 约定：绝大多数函数接收 item = { card, body, file }，而不是裸 card。
 */

const fs = require('fs');
const path = require('path');
const { serializeCard, parseCard, computeDecay, isExpired, normalizeText, todayISO } = require('./schema');

const CARD_ROOT_DIRS = ['semantic', 'episodic', 'procedural', 'inbox', 'archive'];
const MKDIR_DIRS = ['semantic/user', 'semantic/env', 'semantic/conventions', 'semantic/project', 'episodic', 'procedural', 'inbox', 'archive', '.state'];

function openPalace(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  for (const dir of MKDIR_DIRS) fs.mkdirSync(path.join(rootDir, dir), { recursive: true });
  const eventsPath = path.join(rootDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, '');
  return { root: rootDir, eventsPath, stateDir: path.join(rootDir, '.state') };
}

function cardDir(root, card) {
  if (card.status === 'pending-review') return path.join(root, 'inbox');
  if (card.status === 'superseded' || card.status === 'expired') return path.join(root, 'archive');
  if (card.type === 'episodic') return path.join(root, 'episodic');
  if (card.type === 'procedural') return path.join(root, 'procedural');
  if (card.scope.startsWith('project:')) {
    const name = card.scope.slice('project:'.length) || 'default';
    return path.join(root, 'semantic', 'project', name);
  }
  return path.join(root, 'semantic', card.scope || 'user');
}

function walkMarkdown(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function allCardFiles(root) {
  return CARD_ROOT_DIRS.flatMap((d) => walkMarkdown(path.join(root, d))).sort();
}

function readAllCards(root) {
  const items = [];
  for (const file of allCardFiles(root)) {
    let parsed;
    try { parsed = parseCard(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!parsed.card) continue;
    items.push({ card: parsed.card, body: parsed.body, file });
  }
  return items;
}

function findCardFile(root, id) {
  for (const file of allCardFiles(root)) {
    if (path.basename(file, '.md') === id) return file;
  }
  return null;
}

function writeCard(root, card, body) {
  const target = path.join(cardDir(root, card), `${card.id}.md`);
  const existing = findCardFile(root, card.id);
  if (existing && path.resolve(existing) !== path.resolve(target)) fs.rmSync(existing, { force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeCard(card, body), 'utf8');
  return target;
}

function appendEvent(root, event) {
  fs.appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
}

function readEvents(root, limit = 200) {
  const file = path.join(root, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function truncate(text, n = 42) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function decayOf(item) {
  return item.card._decay != null ? item.card._decay : computeDecay(item.card);
}

function statusCounts(items) {
  const counts = { active: 0, 'pending-review': 0, superseded: 0, expired: 0 };
  for (const item of items) if (counts[item.card.status] != null) counts[item.card.status] += 1;
  return counts;
}

function buildCatalog(items, meta = {}) {
  const counts = statusCounts(items);
  const groups = new Map();
  for (const item of items) {
    const key = `${item.card.type} · ${item.card.scope}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const lines = [
    '# 记忆宫殿 · 目录 (CATALOG)',
    '',
    `> 自动生成，请勿手工编辑。生成时间：${meta.generatedAt || new Date().toISOString()}`,
    `> 合计 ${items.length} 条 ｜ active ${counts.active} · pending-review ${counts['pending-review']} · superseded ${counts.superseded} · expired ${counts.expired}`,
    '',
  ];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key).sort((a, b) => decayOf(b) - decayOf(a)
      || String(b.card.updated).localeCompare(String(a.card.updated)));
    lines.push(`## ${key}（${group.length}）`, '', '| id | 状态 | 摘要 | 标签 | 更新 |', '| --- | --- | --- | --- | --- |');
    for (const { card, body } of group) {
      const tags = (card.tags || []).join(' ') || '-';
      lines.push(`| \`${card.id}\` | ${card.status} | ${truncate(body, 42).replace(/\|/g, '/')} | ${tags} | ${card.updated || '-'} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildHealth(items, meta = {}) {
  const counts = statusCounts(items);
  const byType = {};
  const byScope = {};
  for (const { card } of items) {
    byType[card.type] = (byType[card.type] || 0) + 1;
    byScope[card.scope] = (byScope[card.scope] || 0) + 1;
  }
  const lines = [
    '# 记忆宫殿 · 健康报告 (HEALTH)',
    '',
    `> 自动生成。生成时间：${meta.generatedAt || new Date().toISOString()}`,
    '',
    '## 概览',
    `- 总数：${items.length}`,
    `- 状态：active ${counts.active} / pending-review ${counts['pending-review']} / superseded ${counts.superseded} / expired ${counts.expired}`,
    `- 类型：${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`,
    `- 作用域：${Object.entries(byScope).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '-'}`,
    '',
  ];

  const pending = items.filter((i) => i.card.status === 'pending-review');
  lines.push(`## 待裁决（inbox，${pending.length} 条）`, '');
  if (pending.length) for (const { card, body } of pending) lines.push(`- \`${card.id}\` ｜ ${truncate(body, 60)} ｜ confidence ${card.confidence}`);
  else lines.push('- 无');
  lines.push('');

  const superseded = items.filter((i) => i.card.status === 'superseded');
  lines.push(`## 取代链（superseded，${superseded.length} 条）`, '');
  if (superseded.length) for (const { card, body } of superseded) lines.push(`- \`${card.id}\` → \`${card.superseded_by || '(未标注)'}\` ｜ ${truncate(body, 40)}`);
  else lines.push('- 无');
  lines.push('');

  const stale = items.filter((i) => i.card.status === 'active' && decayOf(i) < 0.3)
    .sort((a, b) => decayOf(a) - decayOf(b)).slice(0, 30);
  lines.push(`## 低衰减分（decay < 0.3，长期未访问，${stale.length} 条）`, '');
  if (stale.length) for (const item of stale) lines.push(`- \`${item.card.id}\` ｜ decay ${decayOf(item)} ｜ 最近访问 ${item.card.last_accessed || '从未'} ｜ ${truncate(item.body, 40)}`);
  else lines.push('- 无');
  lines.push('');

  const expired = items.filter((i) => i.card.status === 'active' && isExpired(i.card));
  lines.push(`## 已过期但仍为 active（${expired.length} 条）`, '');
  if (expired.length) for (const { card, body } of expired) lines.push(`- \`${card.id}\` ｜ valid_until ${card.valid_until || '-'} ｜ ${truncate(body, 40)}`);
  else lines.push('- 无');
  lines.push('');

  const suspicious = [];
  const actives = items.filter((i) => i.card.status === 'active');
  for (let i = 0; i < actives.length && suspicious.length < 20; i += 1) {
    for (let j = i + 1; j < actives.length && suspicious.length < 20; j += 1) {
      const a = actives[i];
      const b = actives[j];
      if (a.card.scope !== b.card.scope) continue;
      if (normalizeText(a.body) !== normalizeText(b.body)) continue;
      const ta = new Set(a.card.tags || []);
      const shared = (b.card.tags || []).filter((t) => ta.has(t));
      suspicious.push(`- \`${a.card.id}\` 与 \`${b.card.id}\` 正文相同（疑似重复）${shared.length ? `｜ 共同标签 ${shared.join(' ')}` : ''}`);
    }
  }
  lines.push(`## 疑似重复/冲突（${suspicious.length} 条）`, '');
  lines.push(...(suspicious.length ? suspicious : ['- 无']));
  lines.push('');
  return lines.join('\n');
}

/** 生成建议写入宿主常驻记忆文件的热索引片段（T0），保持有界。 */
function buildT0Snippet(items, { limit = 12, maxChars = 2200 } = {}) {
  const top = items.filter((i) => i.card.status === 'active')
    .sort((a, b) => decayOf(b) - decayOf(a))
    .slice(0, limit);
  const parts = [];
  let used = 0;
  for (const item of top) {
    const line = truncate(item.body, 110);
    if (used + line.length + 3 > maxChars) break;
    parts.push(line);
    used += line.length + 3;
  }
  return [
    '常驻热索引片段（T0 · 有界）',
    '',
    '用途：粘进你的 agent 的常驻记忆文件（如 MEMORY.md / AGENTS.md / SOUL.md / system prompt）。',
    '',
    parts.join('\n§\n'),
    '',
    `索引：完整目录见 CATALOG.md（active ${statusCounts(items).active} 条）`,
  ].join('\n');
}

/** 重建 CATALOG.md / HEALTH.md，可选把最新 decay 持久化回卡片。 */
function rebuildIndex(root, items, options = {}) {
  const { persistDecay = true } = options;
  const generatedAt = new Date().toISOString();
  const now = new Date();
  for (const item of items) item.card._decay = computeDecay(item.card, now);

  if (persistDecay) {
    for (const item of items) {
      if (item.card.status !== 'active') continue;
      if (item.card.decay_score === item.card._decay) continue;
      item.card.decay_score = item.card._decay;
      try { writeCard(root, item.card, item.body); } catch { /* 忽略单条写入失败 */ }
    }
  }
  const catalogPath = path.join(root, 'CATALOG.md');
  const healthPath = path.join(root, 'HEALTH.md');
  fs.writeFileSync(catalogPath, buildCatalog(items, { generatedAt }), 'utf8');
  fs.writeFileSync(healthPath, buildHealth(items, { generatedAt }), 'utf8');
  return { catalogPath, healthPath, t0: buildT0Snippet(items) };
}

/** 待裁决卡片 → 正式 active。 */
function acceptCard(root, id) {
  const file = findCardFile(root, id);
  if (!file) throw new Error(`未找到卡片 ${id}`);
  const { card, body } = parseCard(fs.readFileSync(file, 'utf8'));
  if (!card) throw new Error(`卡片解析失败 ${id}`);
  card.status = 'active';
  card.updated = todayISO();
  card.confidence = Math.max(card.confidence || 0, 0.7);
  const target = writeCard(root, card, body);
  appendEvent(root, { type: 'review_accept', id });
  return { card, body, file: target };
}

/** 待裁决卡片 → 丢弃（归档为 expired，保留来源）。 */
function discardCard(root, id, reason = '人工丢弃') {
  const file = findCardFile(root, id);
  if (!file) throw new Error(`未找到卡片 ${id}`);
  const { card, body } = parseCard(fs.readFileSync(file, 'utf8'));
  card.status = 'expired';
  card.valid_until = todayISO();
  card.updated = todayISO();
  writeCard(root, card, body);
  appendEvent(root, { type: 'review_discard', id, reason });
  return { card };
}

module.exports = {
  CARD_ROOT_DIRS,
  openPalace,
  cardDir,
  walkMarkdown,
  allCardFiles,
  readAllCards,
  findCardFile,
  writeCard,
  appendEvent,
  readEvents,
  truncate,
  statusCounts,
  buildCatalog,
  buildHealth,
  buildT0Snippet,
  rebuildIndex,
  acceptCard,
  discardCard,
};