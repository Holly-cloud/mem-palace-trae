'use strict';

/** 冲突裁决：为候选记忆挑选相似既有记忆，并决定 ADD/UPDATE/SUPERSEDE/MERGE/ESCALATE/NOOP。 */

const { REVIEW_CONFIDENCE_THRESHOLD } = require('./schema');

const OPERATIONS = ['ADD', 'UPDATE', 'SUPERSEDE', 'MERGE', 'ESCALATE', 'NOOP'];

const JUDGE_SYSTEM = `你在做 agent 记忆的冲突裁决。只输出 JSON，不要解释。`;

function cjkBigrams(text) {
  const out = [];
  for (const run of String(text || '').match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

function tokenize(text) {
  const set = new Set();
  const s = String(text || '').toLowerCase();
  for (const word of s.split(/[\s,，。;；、:：()[\]{}"'`/\\|!?！？]+/)) {
    const t = word.replace(/^[#*\-]+/, '').trim();
    if (t.length >= 2) set.add(t);
  }
  for (const bigram of cjkBigrams(s)) set.add(bigram);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function cardTokens(card, body) {
  return tokenize([body, (card.keywords || []).join(' '), (card.tags || []).join(' ')].join(' '));
}

/** 从既有记忆里挑出与候选最相似的前 topK 条。 */
function shortlist(candidate, candidateBody, existing, { minSim = 0.14, topK = 3 } = {}) {
  const cTokens = cardTokens(candidate, candidateBody);
  return existing
    .filter((item) => item.card.status === 'active' && item.card.id !== candidate.id)
    .map((item) => ({ ...item, score: jaccard(cTokens, cardTokens(item.card, item.body)) }))
    .filter((item) => item.score >= minSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function buildJudgePrompt(candidate, candidateBody, targets) {
  const lines = ['新候选记忆：', `- id: ${candidate.id}`, `- type: ${candidate.type} / scope: ${candidate.scope}`,
    `- confidence: ${candidate.confidence}`, `- body: ${candidateBody}`, '', '库中已有相似记忆：'];
  targets.forEach((t, i) => {
    lines.push(`${i + 1}. id: ${t.card.id} (相似度 ${t.score.toFixed(2)})`, `   body: ${t.body}`);
  });
  lines.push('', '请判断应执行哪种操作，只输出 JSON：',
    '{"operation":"ADD|UPDATE|SUPERSEDE|MERGE|ESCALATE|NOOP","targetId":"","reason":"","mergedBody":""}',
    'ADD=无冲突新增；UPDATE=同一事实补充完善(在 mergedBody 给出合并后正文)；SUPERSEDE=旧事实已过时被取代；',
    'MERGE=多条重复合并(在 mergedBody 给出合并后正文)；ESCALATE=不确定或高风险，交人工；NOOP=完全重复可忽略。');
  return lines.join('\n');
}

/** 无 LLM 时的兜底裁决（mock provider 也走 mock 的分支）。 */
function fallbackJudge(candidate, candidateBody, targets) {
  if (!targets.length) return { operation: 'ADD', reason: '无相似记忆' };
  const top = targets[0];
  const a = String(candidateBody).trim().toLowerCase();
  const b = String(top.body).trim().toLowerCase();
  if (a === b) return { operation: 'NOOP', targetId: top.card.id, reason: '内容重复' };
  if (a.includes(b) || b.includes(a)) {
    const merged = a.includes(b) ? candidateBody : `${top.body}\n${candidateBody}`;
    return { operation: 'UPDATE', targetId: top.card.id, reason: '同一事实的补充', mergedBody: merged };
  }
  return {
    operation: 'SUPERSEDE',
    targetId: top.card.id,
    reason: '相关事实更新',
    mergedBody: `${top.body}\n${candidateBody}`,
  };
}

async function resolveCandidate({ provider, candidate, candidateBody, existing, signal, options = {} }) {
  const { minSim = 0.14, topK = 3, reviewThreshold = REVIEW_CONFIDENCE_THRESHOLD } = options;
  const targets = shortlist(candidate, candidateBody, existing, { minSim, topK });

  let decision;
  try {
    const raw = await provider.complete({
      system: JUDGE_SYSTEM,
      user: buildJudgePrompt(candidate, candidateBody, targets),
      json: true,
      task: 'judge',
      meta: { candidate, candidateBody, targets: targets.map((t) => ({ card: t.card, body: t.body, score: t.score })) },
      signal,
    });
    const parsed = require('./extract').parseJsonLoose(raw);
    decision = parsed && OPERATIONS.includes(parsed.operation)
      ? parsed
      : fallbackJudge(candidate, candidateBody, targets);
  } catch {
    decision = fallbackJudge(candidate, candidateBody, targets);
  }

  let operation = OPERATIONS.includes(decision.operation) ? decision.operation : 'ADD';
  if (operation !== 'NOOP' && candidate.confidence < reviewThreshold) operation = 'ESCALATE';

  const target = decision.targetId
    ? existing.find((item) => item.card.id === decision.targetId)
    : targets[0];

  return {
    operation,
    targetId: target ? target.card.id : null,
    reason: decision.reason || '',
    mergedBody: decision.mergedBody || null,
    targets,
  };
}

module.exports = {
  OPERATIONS,
  JUDGE_SYSTEM,
  tokenize,
  jaccard,
  cardTokens,
  shortlist,
  buildJudgePrompt,
  fallbackJudge,
  resolveCandidate,
};