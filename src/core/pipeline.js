'use strict';

/**
 * 转换管线：渐进读取来源 → LLM 抽取 → 冲突裁决 → 落盘，支持断点续跑与幂等。
 * 每个 chunk 处理后立即落盘并写 checkpoint，中断后可从上次位置继续。
 */

const fs = require('fs');
const path = require('path');
const { openPalace, readAllCards, writeCard, appendEvent, rebuildIndex } = require('./store');
const { listSourceFiles, readSourceFile, chunkFile, DEFAULT_MAX_CHARS, sha1 } = require('./sources');
const { extractCards } = require('./extract');
const { resolveCandidate } = require('./resolve');
const { todayISO } = require('./schema');

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed.chunks) parsed.chunks = {};
    return parsed;
  } catch {
    return { chunks: {}, updatedAt: null };
  }
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

function uniq(arr) {
  return [...new Set(arr)];
}

function applyDecision({ root, activeIndex, card, body, decision, stats }) {
  const now = todayISO();
  const findActive = (id) => activeIndex.findIndex((item) => item.card.id === id);

  switch (decision.operation) {
    case 'ADD': {
      writeCard(root, card, body);
      activeIndex.push({ card, body });
      stats.added += 1;
      appendEvent(root, { type: 'add', id: card.id, scope: card.scope });
      return;
    }

    case 'UPDATE': {
      const idx = findActive(decision.targetId);
      if (idx === -1) {
        writeCard(root, card, body);
        activeIndex.push({ card, body });
        stats.added += 1;
        appendEvent(root, { type: 'add', id: card.id, note: 'update-fallback' });
        return;
      }
      const target = activeIndex[idx];
      target.body = decision.mergedBody || `${target.body}\n${body}`;
      target.card.updated = now;
      target.card.confidence = Math.max(target.card.confidence, card.confidence);
      target.card.keywords = uniq([...(target.card.keywords || []), ...(card.keywords || [])]);
      target.card.tags = uniq([...(target.card.tags || []), ...(card.tags || [])]);
      writeCard(root, target.card, target.body);
      stats.updated += 1;
      appendEvent(root, { type: 'update', id: target.card.id, from: card.id });
      return;
    }

    case 'SUPERSEDE':
    case 'MERGE': {
      const targetCards = decision.operation === 'MERGE' && decision.targets?.length
        ? decision.targets.map((t) => t.card)
        : (decision.targetId ? [{ id: decision.targetId }] : []);

      const supersededIds = [];
      // SUPERSEDE 用新事实自身正文；只有 MERGE 才合并旧正文
      let mergedBody = decision.operation === 'MERGE' ? (decision.mergedBody || body) : body;
      for (const tc of targetCards) {
        const idx = findActive(tc.id);
        if (idx === -1) continue;
        const target = activeIndex[idx];
        if (decision.operation === 'MERGE' && !decision.mergedBody && !mergedBody.includes(target.body)) {
          mergedBody += `\n${target.body}`;
        }
        target.card.status = 'superseded';
        target.card.valid_until = now;
        target.card.superseded_by = card.id;
        target.card.updated = now;
        writeCard(root, target.card, target.body); // 迁入 archive/
        activeIndex.splice(idx, 1);
        supersededIds.push(target.card.id);
        appendEvent(root, { type: 'supersede', id: target.card.id, by: card.id });
      }

      card.supersedes = uniq([...(card.supersedes || []), ...supersededIds]);
      card.status = 'active';
      card.updated = now;
      writeCard(root, card, mergedBody);
      activeIndex.push({ card, body: mergedBody });
      if (decision.operation === 'MERGE') stats.merged += 1;
      else stats.superseded += 1;
      appendEvent(root, { type: decision.operation.toLowerCase(), id: card.id, supersedes: supersededIds });
      return;
    }

    case 'ESCALATE': {
      const pending = { ...card, status: 'pending-review' };
      writeCard(root, pending, body); // 落入 inbox/
      stats.escalated += 1;
      appendEvent(root, { type: 'escalate', id: card.id, reason: decision.reason });
      return;
    }

    default:
      stats.noop += 1;
      appendEvent(root, { type: 'noop', id: card.id, reason: decision.reason });
  }
}

/**
 * @param {object} args
 * @param {string} args.sourcePath 来源文件或目录
 * @param {string} args.outputDir  记忆宫殿输出目录
 * @param {object} args.provider   LLM provider
 */
async function runConversion({
  sourcePath,
  outputDir,
  provider,
  options = {},
  onProgress = () => {},
  shouldStop = () => false,
}) {
  if (!provider) throw new Error('缺少 LLM provider');
  if (!fs.existsSync(sourcePath)) throw new Error(`来源不存在：${sourcePath}`);

  openPalace(outputDir);
  const stateFile = path.join(outputDir, '.state', 'convert.json');
  const state = loadState(stateFile);

  const rootId = sha1(path.resolve(sourcePath), 12);
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const files = listSourceFiles(sourcePath);

  const activeIndex = readAllCards(outputDir)
    .filter((item) => item.card.status === 'active')
    .map((item) => ({ card: item.card, body: item.body }));

  const stats = {
    files: files.length, chunks: 0, skippedChunks: 0, candidates: 0,
    added: 0, updated: 0, superseded: 0, merged: 0, escalated: 0, noop: 0,
    failed: 0, warnings: [],
  };

  const report = (extra) => onProgress({ stats: { ...stats }, ...extra });
  report({ phase: 'scan', fileIndex: 0, fileTotal: files.length });

  for (let fi = 0; fi < files.length; fi += 1) {
    if (shouldStop()) { saveState(stateFile, state); return { stopped: true, stats, outputDir }; }
    const file = files[fi];
    const loaded = readSourceFile(file);

    if (loaded.skipped) {
      stats.warnings.push(`${file.relPath}: ${loaded.skipped}`);
      report({ phase: 'converting', fileIndex: fi + 1, fileTotal: files.length, fileRelPath: file.relPath });
      continue;
    }

    const chunks = chunkFile(loaded, { maxChars });
    for (let ci = 0; ci < chunks.length; ci += 1) {
      if (shouldStop()) { saveState(stateFile, state); return { stopped: true, stats, outputDir }; }
      const chunk = chunks[ci];
      const key = `${rootId}:${chunk.hash}`;

      if (options.resume !== false && state.chunks[key] === 'done') {
        stats.skippedChunks += 1;
        report({ phase: 'converting', fileIndex: fi + 1, fileTotal: files.length, fileRelPath: file.relPath, chunkIndex: ci + 1, chunkTotal: chunks.length });
        continue;
      }

      stats.chunks += 1;
      try {
        const { cards, warnings } = await extractCards(provider, chunk, {
          defaultScope: options.defaultScope || 'user',
          signal: options.signal,
        });
        stats.warnings.push(...warnings);

        for (const { card, body } of cards) {
          stats.candidates += 1;
          if (activeIndex.some((item) => item.card.id === card.id)) { stats.noop += 1; continue; }
          const decision = await resolveCandidate({
            provider,
            candidate: card,
            candidateBody: body,
            existing: activeIndex,
            signal: options.signal,
            options: { minSim: options.minSim, topK: options.topK, reviewThreshold: options.reviewThreshold },
          });
          applyDecision({ root: outputDir, activeIndex, card, body, decision, stats });
        }
        state.chunks[key] = 'done';
      } catch (err) {
        stats.failed += 1;
        state.chunks[key] = 'failed';
        stats.warnings.push(`chunk ${chunk.id} 处理失败：${err.message}`);
        appendEvent(outputDir, { type: 'chunk_failed', chunk: chunk.id, error: String(err.message || err) });
      }

      saveState(stateFile, state);
      report({ phase: 'converting', fileIndex: fi + 1, fileTotal: files.length, fileRelPath: file.relPath, chunkIndex: ci + 1, chunkTotal: chunks.length });
    }
  }

  report({ phase: 'indexing', fileIndex: files.length, fileTotal: files.length });
  const index = rebuildIndex(outputDir, readAllCards(outputDir), { persistDecay: options.persistDecay !== false });
  report({ phase: 'done', fileIndex: files.length, fileTotal: files.length });

  return { stopped: false, stats, outputDir, catalog: index.catalogPath, health: index.healthPath, t0: index.t0 };
}

module.exports = { runConversion, applyDecision, loadState, saveState };