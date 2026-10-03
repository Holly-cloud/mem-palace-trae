'use strict';

/**
 * 记忆卡片 schema：定义、校验、以及 YAML front-matter 的最小读写子集。
 * 该子集足以表达我们的卡片字段，避免引入额外 YAML 依赖。
 */

const crypto = require('crypto');

const CARD_TYPES = ['semantic', 'episodic', 'procedural'];
const STATUSES = ['active', 'superseded', 'expired', 'pending-review'];
const DEFAULT_EPISODIC_TTL_DAYS = 90;

// 低于该置信度的候选不直接落为 active，而是升级到 inbox 等待人工裁决
const REVIEW_CONFIDENCE_THRESHOLD = 0.55;

const FIELD_ORDER = [
  'id', 'type', 'scope', 'status', 'confidence', 'source',
  'created', 'updated', 'valid_from', 'valid_until',
  'supersedes', 'superseded_by', 'tags', 'keywords', 'links',
  'ttl_days', 'access_count', 'last_accessed', 'decay_score',
];

const TYPE_PREFIX = { semantic: 'sem', episodic: 'epi', procedural: 'pro' };

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  return s.split(',').map((v) => v.trim()).filter(Boolean);
}

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function shortHash(text, len = 10) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, len);
}

function slugify(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// LLM 常把"不知道该叫什么"写成这些占位名；它们不是真实项目名，应回退
const UNNAMED_PROJECT = new Set(['unknown', 'none', 'na', 'n', 'default', 'unnamed', 'tbd', 'unspecified']);

/**
 * 归一化作用域。无法识别的取值一律回退到 fallback，绝不产生非法 scope
 * （否则卡片会被校验丢弃，等于静默丢记忆）。
 */
function normalizeScope(scope, fallback = 'user') {
  const raw = String(scope == null ? '' : scope).trim();
  if (!raw) return fallback;
  if (/^project[/:]/.test(raw)) {
    const name = slugify(raw.replace(/^project[/:]/, ''));
    if (!name || UNNAMED_PROJECT.has(name)) return fallback;
    return `project:${name}`;
  }
  const slug = slugify(raw);
  if (['user', 'env', 'conventions'].includes(slug)) return slug;
  return fallback;
}

function isValidScope(scope) {
  return scope === 'user'
    || scope === 'env'
    || scope === 'conventions'
    || /^project:[a-z0-9-]+$/.test(String(scope));
}

function normalizeTag(tag) {
  const slug = slugify(String(tag).replace(/^#/, ''));
  return slug ? `#${slug}` : '';
}

function makeId(type, scope, body) {
  const prefix = TYPE_PREFIX[type] || 'mem';
  return `${prefix}-${slugify(scope) || 'user'}-${shortHash(normalizeText(body))}`;
}

function createCard(input = {}) {
  const type = CARD_TYPES.includes(input.type) ? input.type : 'semantic';
  const scope = normalizeScope(input.scope);
  const body = String(input.body == null ? '' : input.body).trim();
  const created = input.created || todayISO();
  const ttl = input.ttl_days == null
    ? (type === 'episodic' ? DEFAULT_EPISODIC_TTL_DAYS : null)
    : Number(input.ttl_days);
  return {
    id: input.id || makeId(type, scope, body),
    type,
    scope,
    status: STATUSES.includes(input.status) ? input.status : 'active',
    confidence: input.confidence == null ? 0.8 : clamp01(input.confidence),
    source: String(input.source == null ? '' : input.source),
    created,
    updated: input.updated || created,
    valid_from: input.valid_from || created,
    valid_until: input.valid_until || null,
    supersedes: asArray(input.supersedes),
    superseded_by: input.superseded_by || null,
    tags: asArray(input.tags).map(normalizeTag).filter(Boolean),
    keywords: asArray(input.keywords).map((k) => String(k).trim()).filter(Boolean),
    links: asArray(input.links),
    ttl_days: Number.isFinite(ttl) ? ttl : null,
    access_count: Number(input.access_count) || 0,
    last_accessed: input.last_accessed || null,
    decay_score: input.decay_score == null ? 1 : clamp01(input.decay_score),
  };
}

function validateCard(card) {
  const errors = [];
  if (!card || typeof card !== 'object') return { ok: false, errors: ['card 不是对象'] };
  if (!card.id) errors.push('缺少 id');
  if (!CARD_TYPES.includes(card.type)) errors.push(`非法 type: ${card.type}`);
  if (!STATUSES.includes(card.status)) errors.push(`非法 status: ${card.status}`);
  if (!isValidScope(card.scope)) errors.push(`非法 scope: ${card.scope}`);
  if (card.confidence < 0 || card.confidence > 1) errors.push('confidence 越界');
  if (card.decay_score < 0 || card.decay_score > 1) errors.push('decay_score 越界');
  return { ok: errors.length === 0, errors };
}

/** 自适应衰减速：按 TTL/默认半衰期指数衰减，被访问越多衰减越慢。 */
function computeDecay(card, now = new Date()) {
  const base = card.ttl_days && card.ttl_days > 0 ? card.ttl_days : 180;
  const ref = card.last_accessed || card.updated || card.created;
  const refDate = new Date(ref);
  const days = Number.isFinite(refDate.getTime())
    ? Math.max(0, (now.getTime() - refDate.getTime()) / 86400000)
    : 0;
  const decay = Math.exp(-days / base);
  const boost = Math.min(0.5, (Number(card.access_count) || 0) * 0.05);
  return clamp01(Math.round((decay * (1 - boost) + boost) * 100) / 100);
}

function isExpired(card, now = new Date()) {
  if (card.valid_until) {
    const t = new Date(card.valid_until);
    if (Number.isFinite(t.getTime()) && t.getTime() <= now.getTime()) return true;
  }
  if (card.ttl_days && card.ttl_days > 0) {
    const ref = new Date(card.updated || card.created);
    if (Number.isFinite(ref.getTime())) {
      const ttlMs = card.ttl_days * 86400000;
      if (now.getTime() - ref.getTime() > ttlMs) return true;
    }
  }
  return false;
}

// ---------- YAML front-matter 最小子集 ----------

function needsQuote(s) {
  if (s === '') return true;
  if (/^(null|~|true|false)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^[[{&*!|>%@`]/.test(s)) return true;
  if (/[:#]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  return false;
}

function serializeScalar(value) {
  if (value == null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(serializeScalar).join(', ')}]`;
  const s = String(value);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

function unquote(raw) {
  const s = String(raw).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  return s;
}

function splitInlineList(inner) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineList(inner).map((p) => unquote(p.trim())).filter((p) => p !== '');
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return unquote(s);
}

function serializeCard(card, body) {
  const lines = ['---'];
  for (const key of FIELD_ORDER) lines.push(`${key}: ${serializeScalar(card[key])}`);
  lines.push('---', '', String(body == null ? '' : body).trim(), '');
  return lines.join('\n');
}

function parseCard(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  if (!src.startsWith('---')) return { card: null, body: src.trim() };
  const rest = src.slice(3);
  const endIdx = rest.search(/\r?\n---(\r?\n|$)/);
  if (endIdx === -1) return { card: null, body: src.trim() };
  const fmText = rest.slice(0, endIdx);
  const body = rest.slice(endIdx).replace(/^\r?\n---/, '').replace(/^\r?\n/, '').trim();

  const fields = {};
  for (const line of fmText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf(':');
    if (idx === -1) continue;
    fields[t.slice(0, idx).trim()] = parseScalar(t.slice(idx + 1));
  }
  return { card: createCard(fields), body };
}

module.exports = {
  CARD_TYPES,
  STATUSES,
  DEFAULT_EPISODIC_TTL_DAYS,
  REVIEW_CONFIDENCE_THRESHOLD,
  FIELD_ORDER,
  todayISO,
  clamp01,
  asArray,
  normalizeText,
  normalizeScope,
  normalizeTag,
  isValidScope,
  shortHash,
  slugify,
  makeId,
  createCard,
  validateCard,
  computeDecay,
  isExpired,
  serializeCard,
  parseCard,
  serializeScalar,
  parseScalar,
};