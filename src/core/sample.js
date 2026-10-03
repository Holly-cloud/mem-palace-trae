'use strict';

/**
 * 散布抽样：从整个记忆库中均匀抽取少量分块，用于"浅尝"式快速预览。
 * 只读取被选中的文件，因此对很大的库也很快；抽样结果是确定性的，便于复现与测试。
 */

const { listSourceFiles, readSourceFile, chunkFile, DEFAULT_MAX_CHARS } = require('./sources');

/** 从 total 个元素里均匀取 take 个下标（用中点法，避免总取到开头）。 */
function spreadIndices(total, take) {
  if (total <= 0 || take <= 0) return [];
  if (take >= total) return [...Array(total).keys()];
  const out = [];
  for (let i = 0; i < take; i += 1) out.push(Math.floor(((i + 0.5) * total) / take));
  return [...new Set(out)];
}

/**
 * @returns {{chunks: Array, stats: {totalFiles:number, sampledFiles:number, sampledChunks:number, skippedOversized:number}}}
 */
function sampleChunks(sourcePath, { maxChunks = 8, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const all = listSourceFiles(sourcePath);
  const files = all.filter((f) => !f.oversized);
  const skippedOversized = all.length - files.length;
  const budget = Math.max(1, Number(maxChunks) || 8);
  const emptyStats = { totalFiles: all.length, sampledFiles: 0, sampledChunks: 0, skippedOversized };

  if (!files.length) return { chunks: [], stats: emptyStats };

  // 先在文件维度均匀散布，再把预算分摊到这些文件里，避免只抽到开头的文件
  const filePicks = spreadIndices(files.length, Math.min(budget, files.length));
  const perFile = Math.max(1, Math.ceil(budget / filePicks.length));
  const chunks = [];
  const sampledFiles = new Set();

  for (const fi of filePicks) {
    if (chunks.length >= budget) break;
    const file = files[fi];
    let fileChunks = [];
    try {
      fileChunks = chunkFile(readSourceFile(file), { maxChars });
    } catch {
      continue;
    }
    if (!fileChunks.length) continue;

    sampledFiles.add(file.relPath);
    const want = Math.min(perFile, budget - chunks.length);
    for (const ci of spreadIndices(fileChunks.length, want)) {
      if (chunks.length >= budget) break;
      chunks.push({ ...fileChunks[ci], sampled: true });
    }
  }

  return {
    chunks,
    stats: {
      totalFiles: all.length,
      sampledFiles: sampledFiles.size,
      sampledChunks: chunks.length,
      skippedOversized,
    },
  };
}

module.exports = { sampleChunks, spreadIndices };