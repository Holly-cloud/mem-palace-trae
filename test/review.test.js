'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runConversion } = require('../src/core/pipeline');
const { createMockProvider } = require('../src/core/llm');
const { readAllCards, acceptCard, discardCard, rebuildIndex } = require('../src/core/store');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mempalace-${name}-`));
}

/** 用极高的 reviewThreshold 让所有候选进入 inbox，以便测试审阅流。 */
async function buildInbox(outputDir) {
  const src = tmpdir('review-src');
  fs.writeFileSync(
    path.join(src, 'notes.md'),
    '# 记录\n\n用户的时区是 Asia/Shanghai。\n\n项目使用 tabs 缩进与 120 字符行宽。\n',
    'utf8',
  );
  const res = await runConversion({
    sourcePath: src,
    outputDir,
    provider: createMockProvider(),
    options: { reviewThreshold: 0.99 },
  });
  assert.ok(res.stats.escalated >= 2, `escalated=${res.stats.escalated}`);
}

test('审阅：低置信候选进入 inbox，采纳后转为 active', async () => {
  const out = tmpdir('palace');
  await buildInbox(out);

  const before = readAllCards(out);
  assert.equal(before.filter((i) => i.card.status === 'active').length, 0);
  const pending = before.filter((i) => i.card.status === 'pending-review');
  assert.ok(pending.length >= 2);
  assert.ok(pending.every((i) => i.file.includes(`${path.sep}inbox${path.sep}`)), '待裁决卡片应位于 inbox/');

  const target = pending[0].card.id;
  acceptCard(out, target);

  const after = readAllCards(out);
  const accepted = after.find((i) => i.card.id === target);
  assert.equal(accepted.card.status, 'active');
  assert.ok(accepted.file.includes(`${path.sep}semantic${path.sep}`), '采纳后应迁入 semantic/');
  assert.equal(after.filter((i) => i.card.status === 'pending-review').length, pending.length - 1);
});

test('审阅：丢弃后归档为 expired 且不参与 active', async () => {
  const out = tmpdir('palace');
  await buildInbox(out);

  const pending = readAllCards(out).filter((i) => i.card.status === 'pending-review');
  const target = pending[0].card.id;
  discardCard(out, target, '测试丢弃');

  const after = readAllCards(out);
  const discarded = after.find((i) => i.card.id === target);
  assert.equal(discarded.card.status, 'expired');
  assert.ok(discarded.file.includes(`${path.sep}archive${path.sep}`), '丢弃后应迁入 archive/');
  assert.equal(after.filter((i) => i.card.status === 'active').length, 0);
});

test('索引：rebuildIndex 生成 T0 片段与 CATALOG/HEALTH', async () => {
  const src = tmpdir('index-src');
  fs.writeFileSync(path.join(src, 'a.md'), '# 事实\n\n此机器运行 Debian 12，安装了 PostgreSQL 16。\n', 'utf8');
  const out = tmpdir('palace');
  await runConversion({ sourcePath: src, outputDir: out, provider: createMockProvider() });

  const result = rebuildIndex(out, readAllCards(out), { persistDecay: true });
  assert.ok(result.t0.includes('MEMORY'));
  assert.ok(fs.readFileSync(result.catalogPath, 'utf8').includes('CATALOG'));
  assert.ok(fs.readFileSync(result.healthPath, 'utf8').includes('健康报告'));
});