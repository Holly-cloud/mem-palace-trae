'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCard, serializeCard, parseCard, computeDecay, isExpired, validateCard, normalizeScope } = require('../src/core/schema');
const { chunkFile } = require('../src/core/sources');
const { createMockProvider } = require('../src/core/llm');
const { runConversion } = require('../src/core/pipeline');
const { readAllCards } = require('../src/core/store');
const { auditSources, auditPalace } = require('../src/core/audit');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mempalace-${name}-`));
}

test('schema：卡片序列化 / 反序列化往返一致', () => {
  const body = '用户在新项目中优先使用 TypeScript。';
  const card = createCard({
    type: 'semantic',
    scope: 'project:my-api',
    body,
    tags: ['preference', 'language'],
    keywords: ['TypeScript'],
    confidence: 0.9,
    source: 'notes/a.md',
  });
  const md = serializeCard(card, body);
  const { card: parsed, body: parsedBody } = parseCard(md);

  assert.equal(parsed.id, card.id);
  assert.equal(parsed.type, 'semantic');
  assert.equal(parsed.scope, 'project:my-api');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.confidence, 0.9);
  assert.deepEqual(parsed.tags, ['#preference', '#language']);
  assert.deepEqual(parsed.keywords, ['TypeScript']);
  assert.deepEqual(parsed.supersedes, []);
  assert.equal(parsed.valid_until, null);
  assert.equal(parsed.ttl_days, null);
  assert.equal(parsedBody, body);
});

test('schema：episodic 默认带 TTL，衰减与过期判断可用', () => {
  const card = createCard({ type: 'episodic', scope: 'user', body: '完成了一次迁移。' });
  assert.equal(card.ttl_days, 90);
  assert.ok(computeDecay(card) > 0 && computeDecay(card) <= 1);

  const old = createCard({ type: 'episodic', scope: 'user', body: '很老的记录' });
  old.updated = '2000-01-01';
  assert.equal(isExpired(old, new Date('2026-01-01')), true);
});

test('schema：无法识别的 scope 回退而非丢弃记忆', () => {
  assert.equal(normalizeScope('project'), 'user');
  assert.equal(normalizeScope('project:unknown'), 'user');
  assert.equal(normalizeScope('project:'), 'user');
  assert.equal(normalizeScope('personal'), 'user');
  assert.equal(normalizeScope('project:My API'), 'project:my-api');
  assert.equal(normalizeScope('conventions'), 'conventions');
  assert.equal(normalizeScope('未知'), 'user', 'CJK 占位名应回退');

  // 回退后的卡片必须仍然通过校验（否则等于静默丢记忆）
  const card = createCard({ type: 'semantic', scope: 'personal', body: '某条事实' });
  assert.equal(card.scope, 'user');
  assert.equal(validateCard(card).ok, true);
});

test('sources：markdown 按标题分段，并按上限合并成 chunk', () => {
  const file = {
    relPath: 'm.md',
    path: '/x/m.md',
    kind: 'markdown',
    text: '# A\n\nalpha one two three\n\n## B\n\nbravo four five six',
  };
  const merged = chunkFile(file, { maxChars: 4000 });
  assert.equal(merged.length, 1, '小文档应合并为单块，避免每个标题触发一次 LLM 调用');

  const split = chunkFile(file, { maxChars: 25 });
  assert.ok(split.length >= 2, `超限时应切分，实际 ${split.length}`);
  assert.ok(split[0].text.includes('alpha'));
  assert.ok(split.every((c) => c.hash && c.sourceLabel === 'm.md'));
});

test('端到端：mock provider 把异构来源转换为记忆宫殿', async () => {
  const src = tmpdir('src');
  fs.writeFileSync(
    path.join(src, 'memory-notes.md'),
    '# 环境\n\n此机器运行 Ubuntu 22.04，安装了 Docker。\n\n# 偏好\n\n我更喜欢 TypeScript 而不是 JavaScript。\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(src, 'notes.txt'),
    '完成了数据库从 MySQL 迁移到 PostgreSQL 的工作，日期 2026-01-15。\n',
    'utf8',
  );

  const out = tmpdir('palace');
  const provider = createMockProvider();
  const res = await runConversion({ sourcePath: src, outputDir: out, provider, options: { defaultScope: 'user' } });

  assert.equal(res.stopped, false);
  assert.ok(res.stats.candidates >= 3, `candidates=${res.stats.candidates}`);
  assert.ok(res.stats.added >= 3, `added=${res.stats.added}`);
  assert.ok(fs.existsSync(path.join(out, 'CATALOG.md')));
  assert.ok(fs.existsSync(path.join(out, 'HEALTH.md')));
  assert.ok(fs.existsSync(path.join(out, 'events.jsonl')));
  assert.ok(typeof res.t0 === 'string' && res.t0.includes('MEMORY'));

  const items = readAllCards(out);
  assert.ok(items.some((i) => i.card.type === 'semantic'), '应有语义记忆');
  assert.ok(items.some((i) => i.card.type === 'episodic'), '应有情景记忆');
  assert.ok(items.some((i) => i.card.scope === 'env'), '应识别出 env 作用域');

  const health = fs.readFileSync(path.join(out, 'HEALTH.md'), 'utf8');
  assert.ok(health.includes('健康报告'));
});

test('冲突：后写入的矛盾事实取代旧事实并归档', async () => {
  const src = tmpdir('conflict');
  fs.writeFileSync(
    path.join(src, 'prefs.md'),
    '用户的默认编辑器是 Vim。\n\n用户的默认编辑器是 VS Code。\n',
    'utf8',
  );
  const out = tmpdir('palace');
  const res = await runConversion({ sourcePath: src, outputDir: out, provider: createMockProvider() });

  assert.ok(res.stats.superseded >= 1, `superseded=${res.stats.superseded}`);
  const items = readAllCards(out);
  const superseded = items.filter((i) => i.card.status === 'superseded');
  assert.equal(superseded.length, 1);
  const active = items.filter((i) => i.card.status === 'active');
  assert.equal(active.length, 1);
  assert.ok(active[0].card.supersedes.includes(superseded[0].card.id), '新卡片应记录取代链');
  assert.equal(superseded[0].card.superseded_by, active[0].card.id);
});

test('断点续跑 / 幂等：第二次运行全部跳过，且不产生重复卡片', async () => {
  const src = tmpdir('resume');
  fs.writeFileSync(path.join(src, 'a.md'), '# 事实\n\n项目使用 Drizzle ORM 与 PostgreSQL。\n', 'utf8');
  const out = tmpdir('palace');
  const provider = createMockProvider();

  const first = await runConversion({ sourcePath: src, outputDir: out, provider });
  const countAfterFirst = readAllCards(out).length;

  const second = await runConversion({ sourcePath: src, outputDir: out, provider });
  assert.equal(second.stats.chunks, 0, '第二次不应再消耗 chunk');
  assert.ok(second.stats.skippedChunks >= 1);
  assert.equal(readAllCards(out).length, countAfterFirst, '不应新增卡片');
});

test('审计：来源体检与宫殿体检可用', async () => {
  const src = tmpdir('audit');
  fs.writeFileSync(path.join(src, 'a.md'), '# A\n\nalpha content here\n', 'utf8');
  fs.writeFileSync(path.join(src, 'b.md'), '# A\n\nalpha content here\n', 'utf8');

  const srcAudit = auditSources(src);
  assert.equal(srcAudit.fileCount, 2);
  assert.equal(srcAudit.duplicateCount, 1, '内容相同的文件应被识别为重复');
  assert.ok(srcAudit.estChunks >= 1);

  const out = tmpdir('palace');
  await runConversion({ sourcePath: src, outputDir: out, provider: createMockProvider() });
  const palaceAudit = auditPalace(out);
  assert.ok(palaceAudit.total >= 1);
  assert.ok(typeof palaceAudit.status.active === 'number');
});