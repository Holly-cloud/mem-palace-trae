'use strict';

/** 抽取阶段：把 chunk 交给 LLM，产出结构化的原子记忆候选。 */

const { createCard, validateCard, normalizeScope, slugify } = require('./schema');

const EXTRACT_SYSTEM = `你是"记忆抽取器"。把一段原始 agent 记忆文本，拆解为若干条原子记忆候选。

规则：
1. 一条候选只表达一件事，自包含、可独立理解。
2. 跳过：无长期价值的寒暄、临时调试上下文、可轻易重新发现的知识、纯代码块/日志转储。
3. 若同一件事出现相互矛盾或前后更新的说法，必须拆成多条独立候选分别输出，各自保留原始表述；
   不要自行概括冲突、做取舍或写"存在冲突"这类元描述——冲突交由下游裁决处理。
4. 每条候选给出字段：
   - type: semantic(稳定事实/偏好/约定) | episodic(带时间的经历/已完成事项) | procedural(可复用的步骤/工作流)
   - scope: user(关于用户) | env(环境/机器/工具) | conventions(代码/项目规范) | project:<名称>
     若无法确定具体项目名，请从 user / env / conventions 中选一个，不要输出裸的 "project"
   - confidence: 0~1，表示该信息被正确理解且长期有效的把握
   - tags: 最多 3 个短标签
   - keywords: 关键实体词
   - body: 一句话到三句话的正文
5. 只输出 JSON，不要任何解释。格式：
{"cards":[{"type":"semantic","scope":"user","confidence":0.9,"tags":["preference"],"keywords":["TypeScript"],"body":"..."}]}`;

function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

function buildExtractPrompt(chunk, meta) {
  return [
    `来源文件：${meta.sourceLabel || chunk.sourceLabel || '(未知)'}`,
    `默认作用域：${meta.defaultScope || 'user'}`,
    '--- 原文开始 ---',
    chunk.text,
    '--- 原文结束 ---',
    '请输出 JSON。',
  ].join('\n');
}

/**
 * @returns {Promise<{cards: Array<{card: object, body: string}>, warnings: string[], rawCount: number}>}
 */
async function extractCards(provider, chunk, options = {}) {
  const meta = {
    chunkText: chunk.text,
    sourceLabel: chunk.sourceLabel,
    defaultScope: options.defaultScope || 'user',
  };
  const raw = await provider.complete({
    system: EXTRACT_SYSTEM,
    user: buildExtractPrompt(chunk, meta),
    json: true,
    task: 'extract',
    meta,
    signal: options.signal,
  });

  const parsed = parseJsonLoose(raw);
  const rawCards = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const warnings = [];
  if (!parsed) warnings.push(`无法解析 LLM 输出为 JSON（chunk ${chunk.id}）`);

  const cards = [];
  const fallbackScope = meta.defaultScope || 'user';
  for (const rc of rawCards) {
    if (!rc || typeof rc !== 'object') continue;
    const body = String(rc.body || rc.text || '').trim();
    if (!body) { warnings.push('跳过空卡片'); continue; }

    // LLM 可能给出无法识别的 scope（如裸 "project"、自定义词），一律回退而不是丢弃该记忆
    const requested = rc.scope ? String(rc.scope).trim() : '';
    const scope = normalizeScope(requested || fallbackScope, fallbackScope);
    const knownScope = !requested
      || /^project[/:]/.test(requested)
      || ['user', 'env', 'conventions'].includes(slugify(requested));
    if (requested && !knownScope) warnings.push(`未知 scope "${requested}"，已回退为 ${scope}`);

    const card = createCard({
      type: rc.type,
      scope,
      confidence: rc.confidence,
      source: meta.sourceLabel,
      tags: rc.tags,
      keywords: rc.keywords,
      ttl_days: rc.ttl_days,
      body,
    });
    const check = validateCard(card);
    if (!check.ok) { warnings.push(`卡片校验失败(${card.id}): ${check.errors.join('; ')}`); continue; }
    cards.push({ card, body });
  }
  return { cards, warnings, rawCount: rawCards.length };
}

module.exports = { EXTRACT_SYSTEM, extractCards, buildExtractPrompt, parseJsonLoose };