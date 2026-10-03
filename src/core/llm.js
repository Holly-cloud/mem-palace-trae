'use strict';

/**
 * 可插拔 LLM 适配层。
 * provider.complete({ system, user, json, task, meta, signal, temperature }) -> string
 *  - task: 'extract' | 'judge'  （真实 provider 忽略它；mock 依据它决定行为）
 *  - meta: 附带的原始数据（mock / 调试用），真实 provider 不使用
 */

const DEFAULT_TIMEOUT_MS = 120000;

async function httpJson(url, { method = 'POST', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function createOpenAIProvider(cfg = {}) {
  const baseUrl = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  return {
    name: 'openai',
    model,
    async complete({ system, user, json = false, signal, temperature = 0.2 }) {
      const payload = {
        model,
        temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      };
      if (json) payload.response_format = { type: 'json_object' };
      const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
      const data = await httpJson(`${baseUrl}/chat/completions`, {
        headers, body: payload, signal, timeoutMs: cfg.timeoutMs,
      });
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('LLM 返回内容为空');
      return content;
    },
  };
}

function createOllamaProvider(cfg = {}) {
  const baseUrl = String(cfg.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = cfg.model || 'qwen2.5:7b';
  return {
    name: 'ollama',
    model,
    async complete({ system, user, json = false, signal, temperature = 0.2 }) {
      const payload = {
        model,
        stream: false,
        options: { temperature },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      };
      if (json) payload.format = 'json';
      const data = await httpJson(`${baseUrl}/api/chat`, {
        body: payload, signal, timeoutMs: cfg.timeoutMs,
      });
      const content = data?.message?.content;
      if (typeof content !== 'string') throw new Error('Ollama 返回内容为空');
      return content;
    },
  };
}

// ---------- Mock provider：离线启发式，用于测试与无网络演示 ----------

const EPISODIC_HINT = /(20\d{2}[-/年]\d{1,2}|昨天|今天|上周|本周|上月|完成|已修复|migrat|deploy|上线)/i;
const PROCEDURAL_HINT = /(^|[\s，。])(步骤|先|然后|接着|运行|执行|命令|配置|安装|用\s*\S+\s*来)/;
const ENV_HINT = /(ubuntu|debian|centos|windows|macos|linux|docker|podman|node|python|postgres|mysql|redis|端口|服务器|机器|系统)/i;
const CONV_HINT = /(缩进|风格|命名|lint|eslint|prettier|规范|约定|tabs|行宽|docstring)/i;
const USER_HINT = /(我(喜欢|偏好|习惯|讨厌|希望)|prefer|偏好|不要|请用)/i;

function guessType(text) {
  if (PROCEDURAL_HINT.test(text)) return 'procedural';
  if (EPISODIC_HINT.test(text)) return 'episodic';
  return 'semantic';
}

function guessScope(text, fallback) {
  if (USER_HINT.test(text)) return 'user';
  if (CONV_HINT.test(text)) return 'conventions';
  if (ENV_HINT.test(text)) return 'env';
  return fallback || 'user';
}

function guessTags(text) {
  const explicit = [...text.matchAll(/#([\w\u4e00-\u9fa5-]+)/g)].map((m) => m[1]);
  if (explicit.length) return explicit.slice(0, 5);
  const derived = [];
  if (USER_HINT.test(text)) derived.push('preference');
  if (ENV_HINT.test(text)) derived.push('environment');
  if (CONV_HINT.test(text)) derived.push('convention');
  if (PROCEDURAL_HINT.test(text)) derived.push('workflow');
  if (EPISODIC_HINT.test(text)) derived.push('history');
  return derived;
}

function guessKeywords(text) {
  const words = text
    .split(/[\s,，。;；、:：()[\]{}"'`/\\|]+/)
    .map((w) => w.replace(/^[#*\-]+/, '').trim())
    .filter((w) => w.length >= 2 && w.length <= 24);
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

function heuristicSegments(chunkText) {
  const bySection = chunkText
    .split(/\r?\n\s*\r?\n|\r?\n§\r?\n/)
    .flatMap((b) => b.split(/\r?\n(?=\s*[-*•]\s+)/));
  return bySection
    .map((s) => s.replace(/^\s*[-*•]\s+/, '').replace(/^#{1,6}\s+/, '').trim())
    .filter((s) => s.length >= 8 && s.length <= 600);
}

function createMockProvider() {
  return {
    name: 'mock',
    model: 'mock-heuristic',
    async complete({ task, meta = {} }) {
      if (task === 'judge') {
        const { candidate, candidateBody, targets = [] } = meta;
        if (!targets.length) return JSON.stringify({ operation: 'ADD', reason: '无相似记忆' });
        const top = targets[0];
        const a = String(candidateBody || candidate?.body || '').toLowerCase();
        const b = String(top.body || '').toLowerCase();
        if (a && b && a === b) return JSON.stringify({ operation: 'NOOP', targetId: top.card.id, reason: '内容重复' });
        if (a && b && (a.includes(b) || b.includes(a))) {
          return JSON.stringify({ operation: 'UPDATE', targetId: top.card.id, reason: '同一事实的补充' });
        }
        return JSON.stringify({
          operation: 'SUPERSEDE',
          targetId: top.card.id,
          reason: '相关事实更新',
        });
      }

      const chunkText = String(meta.chunkText || '');
      const defaultScope = meta.defaultScope || 'user';
      const cards = heuristicSegments(chunkText).map((segment) => ({
        type: guessType(segment),
        scope: guessScope(segment, defaultScope),
        confidence: 0.7,
        tags: guessTags(segment),
        keywords: guessKeywords(segment),
        body: segment,
      }));
      return JSON.stringify({ cards });
    },
  };
}

function createProvider(config = {}) {
  const provider = String(config.provider || 'openai').toLowerCase();
  if (provider === 'mock') return createMockProvider();
  if (provider === 'ollama') return createOllamaProvider(config);
  if (provider === 'openai') return createOpenAIProvider(config);
  throw new Error(`未知的 provider: ${config.provider}`);
}

module.exports = { createProvider, createOpenAIProvider, createOllamaProvider, createMockProvider, httpJson };