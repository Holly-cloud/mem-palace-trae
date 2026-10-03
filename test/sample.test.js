'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sampleChunks, spreadIndices } = require('../src/core/sample');
const { runConversion } = require('../src/core/pipeline');
const { createMockProvider } = require('../src/core/llm');
const { readAllCards } = require('../src/core/store');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mempalace-${name}-`));
}

// 内容彼此独立，避免被裁决器判成"取代"，从而能干净地验证抽样与衔接
const FACTS = [
  '用户偏好深色主题的编辑器界面。',
  '生产数据库使用 PostgreSQL 16，并做主从复制。',
  '部署走 Kubernetes，命名空间按团队划分。',
  '缓存层采用 Redis，键前缀统一为 app:。',
  '日志收集用 Loki，保留 30 天。',
  '代码规范要求 2 空格缩进与单引号。',
  '邮件通知走 SMTP，发件人固定为 bot@example.com。',
  '备份策略是每日全量、每小时增量。',
  '矩阵构建覆盖 Node 18 与 20 两个版本。',
  '前端框架选型最终定为 SvelteKit。',
  '接口鉴权使用 JWT，有效期 2 小时。',
  '告警阈值是 CPU 持续 5 分钟超过 80%。',
];

function seedLibrary(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i += 1) {
    const name = `note-${String(i).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(dir, name), `# 记录${i}\n\n${FACTS[i % FACTS.length]}\n`, 'utf8');
  }
}

test('spreadIndices：均匀取下标、不重复、越界时收敛', () => {
  assert.deepEqual(spreadIndices(10, 3), [1, 5, 8]);
  assert.deepEqual(spreadIndices(3, 5), [0, 1, 2]);
  assert.deepEqual(spreadIndices(0, 3), []);
  assert.deepEqual(spreadIndices(10, 0), []);
});

test('sampleChunks：散布抽样覆盖库首与库尾，而非只取开头', () => {
  const src = tmpdir('sample');
  seedLibrary(src, 40);

  const { chunks, stats } = sampleChunks(src, { maxChunks: 8 });

  assert.equal(stats.totalFiles, 40);
  assert.equal(stats.sampledChunks, 8);
  assert.equal(stats.sampledFiles, 8);
  assert.ok(chunks.every((c) => c.sampled === true));

  const picked = chunks.map((c) => Number(c.sourceLabel.match(/note-(\d+)/)[1])).sort((a, b) => a - b);
  assert.equal(new Set(picked).size, picked.length, '不应重复抽到同一个文件');
  assert.ok(Math.min(...picked) < 10, `应覆盖库首，实际最小下标 ${Math.min(...picked)}`);
  assert.ok(Math.max(...picked) > 30, `应覆盖库尾，实际最大下标 ${Math.max(...picked)}`);
});

test('sampleChunks：预算大于文件数时不会越界或重复', () => {
  const src = tmpdir('small');
  seedLibrary(src, 3);
  const { chunks, stats } = sampleChunks(src, { maxChunks: 10 });
  assert.equal(stats.totalFiles, 3);
  assert.ok(chunks.length >= 1 && chunks.length <= 10);
  assert.equal(new Set(chunks.map((c) => c.hash)).size, chunks.length, '不应出现重复分块');
});

test('浅尝模式：只产出少量记忆，且可与完整转换无重复衔接', async () => {
  const src = tmpdir('taste-src');
  seedLibrary(src, 12);
  const out = tmpdir('taste-palace');
  const provider = createMockProvider();

  const taste = await runConversion({ sourcePath: src, outputDir: out, provider, options: { sample: 3 } });
  assert.equal(taste.stats.sampled, true);
  assert.ok(taste.stats.sample, '应带上抽样统计');
  assert.equal(taste.stats.sample.totalFiles, 12);
  assert.equal(taste.stats.sample.sampledChunks, 3);
  assert.equal(taste.stats.added, 3, `浅尝应只产出 3 条，实际 ${taste.stats.added}`);
  assert.equal(readAllCards(out).length, 3);

  // 完整转换应接着补全，并跳过浅尝已处理的块
  const full = await runConversion({ sourcePath: src, outputDir: out, provider });
  assert.equal(full.stats.sampled, false);
  assert.equal(full.stats.skippedChunks, 3, '完整转换应跳过浅尝已处理的 3 个块');
  assert.equal(full.stats.added, 9, `应补全其余 9 条，实际 ${full.stats.added}`);
  assert.equal(readAllCards(out).length, 12);
});