<div align="center">

# dsh-usage-panel

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Token 用量统计插件，在 Web GUI 的「设置 → 消耗统计」下展示。插件通过会话投影机制增量聚合持久化会话日志，只写入独立的派生统计账本，永不修改原始会话日志。

[English](README.md) · [![npm](https://img.shields.io/npm/v/dsh-usage-panel)](https://www.npmjs.com/package/dsh-usage-panel) [![npm downloads](https://img.shields.io/npm/dm/dsh-usage-panel)](https://www.npmjs.com/package/dsh-usage-panel) [![CI](https://github.com/AlfredChaos/dsh-usage-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/AlfredChaos/dsh-usage-panel/actions/workflows/ci.yml) [![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin) [![Mentioned in Awesome DeepSeek Harness](https://awesome.re/mentioned-badge.svg)](https://github.com/0xsline/awesome-deepseek-harness)

<img src="https://raw.githubusercontent.com/AlfredChaos/dsh-usage-panel/main/assets/demo.gif" width="620" alt="dsh-usage-panel v0.2 使用演示：加载、KPI 动画、热力图入场、悬停明细与时间范围切换" />

</div>

## 页面内容

- **时间范围胶囊** —— 标题下方的 `7 天 / 30 天 / 全部` 分段选择器（默认 30 天）。**汇总数据、每日柱状图、模型环形图、服务商用量**随所选范围重算；活跃热力图（固定近半年）、会话排行保持全历史口径。
- **汇总数据（随范围）** —— 计费输入 / 输出 Token、会话数量（次级标注总会话数与主/子代理用量拆分）、最常用模型及其占比。
- **缓存命中率** —— `缓存读 ÷（未缓存输入 + 缓存读 + 缓存写）`，附读写绝对量（随范围）。
- **活跃热力图** —— 最近半年，GitHub 贡献图式布局（列为周、行为星期）。按非零日用量的四分位分 4 级色阶（固定近半年，不随范围）。
- **每日柱状图** —— 按模型堆叠的每日用量，随顶部胶囊范围展示对应天数。
- **会话用量排行** —— 最耗 Token 的 10 个会话（含折叠标题），每行按委派深度标注**主会话**或**子代理**（全历史口径）。
- **服务商用量** —— 多 Provider 时以横向条形按路由展示各自 Token 消耗（随顶部范围口径）。
- **模型环形图** —— 各模型在当前范围内的占比，旁边列出前 5 名；每行带**缓存命中率**列，颜色与对应分段一致。
- **导出** —— 完整 JSON、每日 CSV、模型 CSV（防公式注入、RFC 4180、UTF-8 BOM）。

悬停柱子、热力图格子或环形图分段可以看到具体明细：

| 柱状图悬停 | 概览（KPI + 热力图） | 会话排行与服务商 |
| --- | --- | --- |
| <img src="https://raw.githubusercontent.com/AlfredChaos/dsh-usage-panel/main/assets/screenshot-hover-bar.png" width="200" alt="柱状图悬停明细" /> | <img src="https://raw.githubusercontent.com/AlfredChaos/dsh-usage-panel/main/assets/screenshot-overview.png" width="200" alt="KPI 卡片与热力图概览" /> | <img src="https://raw.githubusercontent.com/AlfredChaos/dsh-usage-panel/main/assets/screenshot-sessions.png" width="200" alt="会话用量排行与服务商用量" /> |

## 安装

插件以 bundle 形式发布：`dsh plugin add` 会把它追加到 profile 的 bundle 列表，patch 行负责挂载 Host 半。

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-usage-panel

# 或从 GitHub 安装
dsh plugin --profile web add github:AlfredChaos/dsh-usage-panel

# 或从本地目录安装
dsh plugin --profile web add ./dsh-usage-panel
```

重启 `dsh --profile web`，打开「设置 → 消耗统计」。持久删除保留依赖宿主启用 `storageDomain`（标准 Web profile 已提供）；若宿主没有该服务，面板仍可统计，但不能承诺删除原始日志后的保留。npm 包内 `lib/` 下是预构建的纯 JavaScript 产物，无安装脚本；GitHub 安装同样不需要 pnpm 的构建放行，因为仓库里提交了相同的文件。卸载：

```sh
dsh plugin --profile web remove dsh-usage-panel
```

## 数据来源

Host 半聚合持久化会话日志与独立的历史统计账本：

- **主路径（增量）**：注册一个会话投影（`ctx.sessionProjections`，带 `stateVersion` 校验），把每个已提交事件折叠进四个互斥桶 —— 未缓存输入 / 输出 / 缓存读 / 缓存写 —— 以及按模型、按 Provider、按天（UTC）的映射。checkpoint 落盘，重启与保鲜扫描几乎零回放。
- **历史统计账本**：在 `storageDomain` 的 `usage_stats` 域中按「会话 ID + 创建时间 + cwd」保存已计算结果和持久化 revision。revision 不变就直接复用，只有该会话更新才重算；账本行不会随归档或原始日志删除而删除。
- **回退路径（带 revision 缓存）**：投影服务不可用时，同一套 reducer 通过只读 `sessionQuery` 服务计算；已缓存且 revision 未变的会话不再读取日志。

记账规则：`request/header` 与 `request/context` 记录模型（context 打底、header 覆盖）；对于缺少这些 request 事件的旧日志，从完整的 `assistant/message.message.source` 读取准确的 Provider/模型路由；该步骤的 `assistant/message` 用量**替换**流式暂记用量（同一步重试的消息不会重复累计）；`llm/retry` 事件只计重试次数、不计 Token；`compaction/summary` 用量归属其自身模型并单独披露；reasoning token 已含于 output，绝不重复相加。统计覆盖 profile 内全部会话；子会话仍按自己的 `cwd` 归属，`parentSession` 仅表示谱系关系。

**子会话（fork）去重**：第一个 `session/end-seed` 标记之前的事件（fork 构造种子；有 `header.seedLength` 时以其为准）一律不计数，fork 出的会话不会重复计算父会话的用量。DSH 每次重启后重开会话都会追加一个新标记（生命周期重种子）；这些**后续标记不移动边界**，长对话跨重启、跨反复压缩仍保留完整 Token 历史。

**日期口径声明**：日桶与导出均按 **UTC** 自然日（`YYYY-MM-DD`）。热力图副标题明确标注口径（"最近半年 · UTC"）。

插件不写回原始会话日志，只写入独立的派生统计账本。因此统计在重启后依然存在；已完成首次扫描的会话即使之后被归档或删除原始日志，Token 历史也不会消失。插件首次启用时会先为现有会话建立账本；如果会话在首次扫描前就已被物理删除，则无法从不存在的原始日志恢复。

## 加载策略

插件加载时立即开始首次扫描，打开页面时通常直接命中缓存。Host 会先读取持久化账本和每个会话的轻量 revision：revision 未变的会话直接复用结果，只有新增或变化的会话才计算；首次遇到的会话才建立账本行。缓存 10 分钟内视为新鲜；更旧的缓存会立即返回并标记 `stale`（页面显示「后台更新中…」），同时后台重扫刷新。每 10 分钟定时轻量重扫保鲜，刷新按钮始终强制同步重扫。浏览器还会把最近一次成功载荷存入 `localStorage`（带版本号与结构校验），刷新页面即刻渲染；刷新失败时保留旧数据并如实标注，绝不伪装最新。

## 单位

中文界面：≥ 1 亿 用「亿」，≥ 1 万 用「万」，否则原值；英文界面：K / M / B。

## 实现

源码为 TypeScript（strict）位于 `src/`，esbuild 构建；`lib/` 产物提交进仓库，安装无需构建步骤。

| 文件 | 说明 |
| --- | --- |
| `src/host/index.ts` → `lib/index.js` | Host 半（Cordis 插件）：投影注册、持久统计账本、聚合、带预热的 RPC 缓存、fail-soft 回退 |
| `src/host/projection.ts` | 纯函数会话投影 reducer（四桶、fork 去重、重试/压缩语义、UTC 日桶） |
| `src/host/history.ts` | 独立持久统计账本（revision 命中、会话生命周期隔离、归档/删除后保留） |
| `src/host/aggregate.ts` | 跨会话合并 → overview 载荷 |
| `src/client/*` → `lib/client.js` | Client 半（`./client` 导出，`__ModuleLoader__` bundle）：TSX 设置页 UI，`--dsw-*` 变量，中英双语 |
| `src/shared/contract.ts` | host↔client wire 契约（单一来源） |
| `cordis.patch.yml` | Bundle patch：向 profile 组合插入 `usage-stats` 行 |

Host 通过 `ctx.connection.rpc.handle('/usage-stats', …, { authority: 'loopback' })` 提供 `overview` 端点，浏览器经 `rpc.call('/usage-stats', 'overview', …)` 调用。overview 载荷包含 `coverage`（总会话数与主/子代理用量拆分，展示于会话数量 KPI 次级文字）、`topSessions`、`providers`，会话数量按窗口提供 `sessionCount`（最近 30 天有用量会话）与 `weekSessionCount`（最近 7 天有用量会话）；服务商同样按窗口提供 `providers`（最近 30 天）/ `week.providers`（最近 7 天）/ `allTime.providers`（全历史），而 `topSessions` 保持全历史口径；并保留 v0.1.0 形态的 `days` / `totals` / `byModel` / `allTime`（7 天 / 30 天的金额与分模型在客户端由 `days` 滚动，`全部` 用 `allTime`）。基于 DeepSeek Harness `0.1.0-rc.6` 开发验证。测试使用 Node 内置 test runner（`npm test`）；CI 执行 typecheck + build + test + 打包门禁。

## License

[MIT](LICENSE)
