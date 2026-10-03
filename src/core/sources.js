'use strict';

/**
 * 来源适配器：扫描任意目录/文件，读取 md/txt/json/jsonl/yaml/csv 等纯文本记忆，
 * 归一化成可抽取的文本，再切分为 chunk。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIND_BY_EXT = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.txt': 'text', '.text': 'text', '.log': 'text', '.rst': 'text', '.org': 'text',
  '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.csv': 'csv', '.tsv': 'csv',
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.next', 'dist', 'build', 'out',
  '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage',
  'target', '.pytest_cache', '.mypy_cache',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件 2MB 安全上限
const DEFAULT_MAX_CHARS = 4000;

function sha1(text, len = 16) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, len);
}

function detectKind(filePath) {
  return KIND_BY_EXT[path.extname(filePath).toLowerCase()] || 'unknown';
}

function isTextFile(filePath) {
  return detectKind(filePath) !== 'unknown';
}

function walkFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return isTextFile(target) ? [target] : [];
  const out = [];
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && isTextFile(full)) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/** 扫描来源并返回文件清单（不做内容读取，供审计/进度使用）。 */
function listSourceFiles(target) {
  const stat = fs.statSync(target);
  const rootDir = stat.isDirectory() ? target : path.dirname(target);
  return walkFiles(target).map((filePath) => {
    const st = fs.statSync(filePath);
    return {
      path: filePath,
      relPath: path.relative(rootDir, filePath).split(path.sep).join('/'),
      kind: detectKind(filePath),
      bytes: st.size,
      oversized: st.size > MAX_FILE_BYTES,
    };
  });
}

function readSourceFile(file) {
  if (file.oversized) return { ...file, text: '', skipped: 'oversized' };
  let text = '';
  try {
    text = fs.readFileSync(file.path, 'utf8');
  } catch (err) {
    return { ...file, text: '', skipped: `read-error: ${err.message}` };
  }
  return { ...file, text, hash: sha1(text) };
}

function flattenJson(value, prefix = '', out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenJson(v, prefix ? `${prefix}[${i}]` : `[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push(prefix ? `${prefix}: ${value}` : String(value));
  }
  return out;
}

/** 把结构化来源摊平成自然语言行，便于 LLM 抽取。 */
function normalizeForExtraction(file) {
  if (file.kind === 'json') {
    try { return flattenJson(JSON.parse(file.text)).join('\n'); } catch { return file.text; }
  }
  if (file.kind === 'jsonl') {
    const blocks = file.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      try { return flattenJson(JSON.parse(line)).join('\n'); } catch { return line; }
    });
    return blocks.join('\n---\n');
  }
  return file.text;
}

function splitMarkdownSections(text) {
  const sections = [];
  let cur = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line) && cur.some((l) => l.trim())) {
      sections.push(cur.join('\n'));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.some((l) => l.trim())) sections.push(cur.join('\n'));
  return sections.map((s) => s.trim()).filter(Boolean);
}

function chunkByBlocks(text, maxChars) {
  const blocks = String(text).split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const block of blocks) {
    if (block.length > maxChars) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < block.length; i += maxChars) chunks.push(block.slice(i, i + maxChars));
      continue;
    }
    if (cur && `${cur}\n\n${block}`.length > maxChars) {
      chunks.push(cur);
      cur = block;
    } else {
      cur = cur ? `${cur}\n\n${block}` : block;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 把单个来源文件切成 chunk。
 * markdown 先按标题分段，再把小段合并到 maxChars 上限——避免"每个标题一次 LLM 调用"。
 */
function chunkFile(file, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const normalized = normalizeForExtraction(file);
  const segments = file.kind === 'markdown' ? splitMarkdownSections(normalized) : [normalized];
  const chunks = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };

  for (const seg of segments) {
    if (seg.length > maxChars) {
      flush();
      chunks.push(...chunkByBlocks(seg, maxChars));
      continue;
    }
    if (current && `${current}\n\n${seg}`.length > maxChars) flush();
    current = current ? `${current}\n\n${seg}` : seg;
  }
  flush();

  return chunks
    .map((text) => text.trim())
    .filter((text) => text.length >= 8)
    .map((text, index) => ({
      id: `${file.relPath}#${index}`,
      sourcePath: file.path,
      sourceLabel: file.relPath,
      kind: file.kind,
      index,
      text,
      hash: sha1(`${file.relPath}:${text}`),
    }));
}

module.exports = {
  DETECT: KIND_BY_EXT,
  MAX_FILE_BYTES,
  DEFAULT_MAX_CHARS,
  sha1,
  detectKind,
  isTextFile,
  walkFiles,
  listSourceFiles,
  readSourceFile,
  normalizeForExtraction,
  splitMarkdownSections,
  chunkByBlocks,
  chunkFile,
};