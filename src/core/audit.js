'use strict';

/** 审计：转换前的来源体检 + 现有宫殿体检，用于"人工了解现状"。 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles, readSourceFile, chunkFile, DEFAULT_MAX_CHARS } = require('./sources');
const { readAllCards, statusCounts } = require('./store');
const { computeDecay, isExpired } = require('./schema');

/** 扫描来源，统计规模、类型分布、重复文件与预计 chunk 数（不写任何东西）。 */
function auditSources(target, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!fs.existsSync(target)) throw new Error(`来源不存在：${target}`);
  const files = listSourceFiles(target);
  const byKind = {};
  const seen = new Map();
  const duplicates = [];
  const oversizedFiles = [];
  let totalBytes = 0;
  let estChunks = 0;

  for (const file of files) {
    totalBytes += file.bytes;
    byKind[file.kind] = (byKind[file.kind] || 0) + 1;
    if (file.oversized) { oversizedFiles.push(file.relPath); continue; }
    const loaded = readSourceFile(file);
    if (loaded.skipped) continue;
    estChunks += chunkFile(loaded, { maxChars }).length;
    if (seen.has(loaded.hash)) duplicates.push({ path: file.relPath, duplicateOf: seen.get(loaded.hash) });
    else seen.set(loaded.hash, file.relPath);
  }

  return {
    root: path.resolve(target),
    fileCount: files.length,
    totalBytes,
    byKind,
    oversized: oversizedFiles.length,
    oversizedFiles,
    estChunks,
    duplicateCount: duplicates.length,
    duplicates: duplicates.slice(0, 50),
  };
}

/** 体检现有宫殿：状态分布、类型分布、待裁决清单、过期与低分卡片。 */
function auditPalace(root) {
  if (!fs.existsSync(root)) return null;
  const items = readAllCards(root);
  if (!items.length) {
    return { root: path.resolve(root), total: 0, status: statusCounts(items), byType: {}, byScope: {}, pendingIds: [], expiredIds: [], staleIds: [] };
  }
  const byType = {};
  const byScope = {};
  for (const { card } of items) {
    byType[card.type] = (byType[card.type] || 0) + 1;
    byScope[card.scope] = (byScope[card.scope] || 0) + 1;
  }
  const pendingIds = items.filter((i) => i.card.status === 'pending-review').map((i) => i.card.id);
  const expiredIds = items.filter((i) => i.card.status === 'active' && isExpired(i.card)).map((i) => i.card.id);
  const staleIds = items
    .filter((i) => i.card.status === 'active' && computeDecay(i.card) < 0.3)
    .map((i) => i.card.id);
  return {
    root: path.resolve(root),
    total: items.length,
    status: statusCounts(items),
    byType,
    byScope,
    pendingIds,
    expiredIds,
    staleIds,
  };
}

module.exports = { auditSources, auditPalace };