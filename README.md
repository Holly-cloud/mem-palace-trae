# Memory Palace Converter

把**异构的 agent 记忆**渐进转换为结构化「记忆宫殿」的桌面工具。

它不绑定任何特定 agent：输入是任意纯文本记忆（`md` / `txt` / `json` / `jsonl` / `yaml` / `csv`），输出是一套分层、可治理、可人工审阅的记忆库。

## 为什么需要它

长期运行的 agent，记忆会持续膨胀：内容重复、新旧事实冲突、过期信息堆积、人工难以了解现状。把这些统统塞进上下文只会让问题更糟。

本工具把记忆**从"一堆文本"变成"受治理的结构"**：

- **分层** —— 热索引（T0）/ 语义事实 / 情景记录 / 程序，各层生命周期不同
- **原子化** —— 一条记忆一件事，带结构化字段（`type` / `scope` / `status` / `confidence` / 有效期 / 取代链）
- **写入即裁决** —— 新记忆先与既有记忆比对，再决定新增 / 更新 / 取代 / 合并 / 待裁决 / 忽略
- **自动产出索引与体检报告** —— `CATALOG.md` 是宫殿地图，`HEALTH.md` 是健康报告
- **渐进且可续跑** —— 逐块处理、边处理边落盘，中断后可继续；重复运行不产生重复记忆

## 特性

| 能力 | 说明 |
| --- | --- |
| 可插拔 LLM | 任意 OpenAI 兼容端点（DeepSeek / OpenRouter / 自建 vLLM…）或本地 Ollama；另有无需网络的离线启发式，用于演示与冒烟 |
| 异构来源 | 文件或目录；自动跳过 `node_modules` / `.git` 等；JSON / JSONL 会摊平成可抽取文本 |
| 冲突处理 | `supersedes` / `superseded_by` 取代链 + `valid_until`，旧事实归档而非删除，保留可追溯性 |
| 过期与衰减 | `ttl_days` 与指数衰减分；健康报告列出低分与已过期记忆 |
| 人工关卡 | 低置信或不确定的候选进入 `inbox/`，在「审阅」页采纳或丢弃 |
| 幂等续跑 | 按内容哈希做 checkpoint，重复运行自动跳过已处理块 |

## 安装

需要 Node.js 18+（开发时使用 v24）。

```bash
npm install
npm start     # 启动桌面应用
npm test      # 运行测试（14 个用例）
```

## 使用

1. **设置** —— 选择 provider（OpenAI 兼容 / Ollama / 离线启发式），填 Base URL、API Key、模型，点「测试连接」确认可达。
2. **转换** —— 选择记忆来源与输出目录 → 先点「来源体检」看规模 → 点「开始转换」。过程中可随时「停止」，再次开始会从断点续跑。
3. **审阅** —— 处理进入 `inbox/` 的待裁决记忆。
4. **索引** —— 查看 `CATALOG.md` / `HEALTH.md`，以及可粘贴进宿主常驻记忆文件的热索引片段（T0）。

> 离线启发式不需要任何密钥，但它只是占位实现，`type` / `scope` 的分类质量有限。正式使用请接真实模型。

## 输出结构

```
<输出目录>/
├── CATALOG.md        自动生成的全量索引（宫殿地图）
├── HEALTH.md         自动生成的健康报告（待裁决 / 取代链 / 低分 / 过期 / 疑似重复）
├── semantic/         语义事实（按 scope 分目录：user / env / conventions / project/<名称>）
├── episodic/         情景记录（带 TTL）
├── procedural/       程序与工作流
├── inbox/            待裁决
├── archive/          已被取代或过期的记忆（保留来源）
├── events.jsonl      追加型事件日志（审计与回放）
└── .state/           断点续跑状态
```

## 记忆卡片

每张卡片是一个带 YAML front-matter 的 markdown 文件，既能被人直接阅读，也能被程序解析。

```markdown
---
id: sem-user-a1b2c3d4e5
type: semantic
scope: user
status: active
confidence: 0.9
source: session-notes.md
created: 2026-03-02
updated: 2026-03-02
valid_from: 2026-03-02
valid_until: null
supersedes: []
superseded_by: null
tags: ["#preference"]
keywords: ["TypeScript"]
links: []
ttl_days: null
access_count: 0
last_accessed: null
decay_score: 1
---
用户偏好简洁直接的回答。
```

字段含义：

| 字段 | 作用 |
| --- | --- |
| `type` / `scope` | 决定归档位置与检索过滤维度 |
| `status` | `active` / `pending-review` / `superseded` / `expired`，非 active 不参与检索 |
| `valid_from` / `valid_until` | 双时间轴，事实"失效"而非被删除 |
| `supersedes` / `superseded_by` | 取代链，回答"为什么改了" |
| `confidence` | 低于阈值时升级为待裁决 |
| `ttl_days` / `decay_score` / `access_count` | 过期与衰减治理 |

## 裁决操作

| 操作 | 含义 |
| --- | --- |
| `ADD` | 无冲突，新增 |
| `UPDATE` | 同一事实的补充完善 |
| `SUPERSEDE` | 旧事实过时，被新事实取代（旧卡归档并记录取代链） |
| `MERGE` | 多条重复合并为一条 |
| `ESCALATE` | 不确定或高风险，进入 `inbox/` 等人工确认 |
| `NOOP` | 完全重复，忽略 |

## 架构

```
src/core/     纯 Node，不依赖 Electron（可单测，也可复用为 CLI / 其他宿主）
  schema.js   卡片 schema、校验、front-matter 读写、衰减与过期
  sources.js  来源扫描、归一化、分块
  llm.js      可插拔 LLM 适配层
  extract.js  chunk → 原子记忆候选
  resolve.js  冲突裁决
  store.js    落盘、状态迁移、索引与报告生成
  audit.js    来源体检 / 宫殿体检
  pipeline.js 渐进转换管线
src/main/     Electron 主进程与 IPC
src/preload/  安全桥（contextIsolation）
src/renderer/ 渲染层（无构建步骤的原生 HTML/CSS/JS）
```

渲染层零构建：Electron 直接加载 `src/renderer/index.html`，修改后重启即可生效。核心逻辑与 Electron 完全解耦，因此可以脱离 GUI 单测或复用。

## 开发

```bash
npm test
```

测试覆盖：schema 序列化往返与 scope 回退、分块与合并、端到端转换、冲突取代归档、断点续跑幂等、审阅采纳/丢弃、索引生成，以及 GUI 接线一致性（DOM id / preload API / IPC 通道三重交叉校验）。

## 已知限制

- **无版本级增量**：重新转换同一来源时靠内容哈希跳过已处理块，而非做差异合并。
- **`distil` 尚未实现**：每晚衰减清理与"情景 → 语义"整合还没做，目前衰减分在重建索引时计算。
- **程序记忆不自动可执行**：`procedural` 只做抽取与归档，不会自动变成宿主可调用的技能。
- **密钥为明文**：API Key 以明文存于本地应用配置（`userData/config.json`），未做加密。
- **未附带许可证文件**：如需开源授权请自行添加。

## 许可

本项目暂未附带许可证文件。