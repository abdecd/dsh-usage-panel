# DECISIONS.md — v0.2.0 迭代决策记录

> 每个 P0/P1 项的决策与验收证据。遵循策略文档与 AGENTS.md 的既定方向；所有偏离都记录在案。

## D1. 数据路径：投影为主、全量重扫为回退，共用同一 reducer
- **决策**：`sessionProjections` + `sessionProjectionCache` 可用时走增量投影（`mode: 'projection'`）；不可用或注册失败时 fail-soft 到 `sessionQuery` 全量重扫（`mode: 'scan'`）；`sessionQuery` 也没有时 `mode: 'none'`。两条路径共用 `src/host/projection.ts` 的 `applyEvent`（单一记账核心）。
- **验收**：`tests/projection.test.ts`（14 用例）+ `tests/aggregate.test.ts`（4 用例）全绿；host 导出 `{name, inject, apply}` 与 v0.1.0 一致。

## D2. 种子边界：最后 `session/end-seed` 标记（武装语义）⚠️ 已被 D15 取代
- **决策**：投影注册表的冷折叠是单趟（`init` + 逐事件 `apply`，无回看），故 reducer 采用武装语义——看到最后一个 `session/end-seed` 之前一律不计数；`foldEvents` 与 scan 路径先预扫最后一个标记再折叠。scan 模式对无标记的旧日志用 `header.seedLength` 合成边界（v0.1.0 兼容），两者皆无时从 seq 0 计数。
- **已知限制**：投影模式下"双重 fork"（种子内再种子的日志）会把第二个种子计入（v0.1.0 的 seedLength 可处理）；属边缘场景，记录于 projection.ts 注释。
- **验收**：`seed events are never counted` 用例；scan 路径合成边界逻辑在 scan.ts 有注释。
- **⚠️ 取代说明**：该决策把 dsh 重启追加的"重种子"标记误当种子边界，导致重启后长对话历史全部丢失（真实用户事故），由 D15 以"第一个标记 = fork 边界"取代；原验收用例已改写。

## D3. 日期口径：UTC 日桶 + 显式声明
- **决策**：`dayKeyUTC` 全量替换 v0.1.0 的本地时区 `dayKey`；README 与覆盖度卡片声明口径。
- **偏离说明**：最近 30 天窗口从"事件时间戳 >= now-30d"改为"日桶 key >= 今天-30d"（日粒度边界，差异 < 1 天），两模式一致。
- **验收**：`tests/usage.test.ts`（UTC 跨时区用例）、`buildDayWindow` 用例。

## D4. 命中率公式（无需 clamp）
- **决策**：DSH `TokenUsage` 四桶**互斥**（`inputTokens` 只含未缓存输入，已核 `dsh-llm` 类型注释），故 `hitRate = cacheRead / (input + cacheRead + cacheWrite)`，分母为 0 返回 null；v0.1.0 的 `total = 四桶之和` 确认无重复计。
- **验收**：`tests/usage.test.ts` `hitRate` 用例 + `totalsFrom sums the four disjoint buckets` 用例。

## D5. i18n：DSH locale 服务 + 本地词典回退
- **决策**：client `inject` 追加 `locale`；词典经 `ctx.locale.register(NS, …)` 注册，`bind` 翻译，`locale/change` 事件驱动重渲染；设置页 label 用 thunk 每次重读。host 只返回错误码（`ErrorCode`），文案映射全部在 client。
- **偏离说明**：使用 untyped `bind`（命名空间未并入 `LocaleNamespaceMap` 合并表，属官方允许路径）；注册失败时回退本地 zh 词典。
- **验收**：`createI18n` 单测未单列（依赖宿主运行时），词典键与组件一一对应；错误码枚举在 contract.ts。

## D6. 导出在客户端完成
- **决策**：CSV/JSON 由客户端从 overview 载荷构建（`src/client/export.ts`），不新增 RPC 端点；防公式注入 `=+-@` 前缀、RFC 4180、UTF-8 BOM、UTC 日期键。
- **验收**：`tests/export.test.ts` 4 用例全绿。

## D7. Provider 维度：日志采集 + listProviders 命名
- **决策**：`request/context.provider` 与 `request/header.config.provider` 双源采集（与模型归因同构），`llm.listProviders()` 只用于名字解析（失败回退路由 id）。未做 settings 解析（策略原文提及，量级不符，记入 P2 决策文档）。
- **验收**：`tests/projection.test.ts` 归因用例断言 `byProvider`；`aggregate.test.ts` 断言 `providers` 行。

## D8. 构建：esbuild + 自写 wrap，不用 tsdown
- **决策**：host ESM 全外部化；client CJS bundle（`react` 外部）套 `__ModuleLoader__.load` 工厂；声明产物走 tsc。拒绝 token-usage 的 tsdown/monorepo 布局耦合。
- **验收**：`scripts/build.mjs` + `wrap-client.mjs`；模拟 loader 加载 `lib/client.js` 返回 `{apply, inject: ['slots','connection','locale']}`。

## D9. 依赖事实修正
- **决策**：`@deepseek-ai/cordis` 实为 `^4.0.1`（cordis v4 fork，非 rc.6 号段）；`dsh-session-projection` peer 要求 **zod ^4.4.3**（v4 的 `z.record` 需双参）；`SessionId` 是品牌类型。`cordis-plugin-timer` 仅作 devDep 类型源，产物零运行时 import（本地声明增强替代）。
- **验收**：typecheck 全绿、`npm ls` 无冲突。

## D10. P2 四项：全部 no-go（书面结论）
- **决策**：见 `docs/P2-decisions.md`——费用/预算/悬浮窗/余额 API 各有硬前提（真实价目、覆盖完整、公开 overlay slot、opt-in 降级），本轮不实现，建议 v0.3.0 重新评估。

## D11. 覆盖度与统计字段
- **决策**：`coverage.eventsCounted` 仅在 scan 模式填充（投影模式不重放全量事件）；`compactionTokens` 与 `retries` 全局聚合；`topSessions` 取全历史 Top 10，标题在 scan 模式折叠自日志、投影模式只对 Top10 调 `readTitle`（读盘上限 10 次/扫描）。
- **验收**：`finalizeOverview` 用例断言 coverage/titles/providers 字段。

## D12. 打包门禁
- **决策**：`files` 白名单仅 `lib/` + patch + READMEs；`scripts/check-pack.mjs` 挂 `prepublishOnly` 与 CI；README 图片指向 GitHub raw URL。
- **验收**：`npm run check-pack` 通过；`npm pack --dry-run` 清单无资产（见 PR 描述）。

## D13. 时间范围胶囊（7 天 / 30 天 / 全部）
- **决策**：标题下新增全局范围胶囊（默认 30 天），驱动**汇总数据、每日柱状图、模型环形图、服务商用量（见 D14）**四个窗口型统计视图重算；**活跃热力图（固定近半年）、会话排行**保持全历史口径（属下钻/上下文视图，非窗口汇总，且热力图是固定半年网格、按 7 天过滤无意义）。
- **实现**：纯函数 `windowFromDays(days, n)`（`src/shared/usage.ts`）在客户端把 `days` 滚成窗口 `totals` + 排序后的 `byModel`；7/30 天金额与分模型由此得出（host 的 30 天 `totals`/`byModel` 与其同口径，可互证），`全部` 直接用 `allTime`（`days` 只覆盖 182 天）。会话数来自 host：7 天→新增 `weekSessionCount`、30 天→`sessionCount`、全部→`allTime.sessionCount`。原柱状图内联的 7/14/30 选择器移除，避免与胶囊冲突。
- **偏离说明**：契约新增 `Overview.weekSessionCount`，`OVERVIEW_VERSION` 由 3 升到 4 使旧缓存失效；`isUsable` 校验该字段。
- **验收**：`tests/usage.test.ts` 新增 `windowFromDays` 用例；`tests/aggregate.test.ts` 新增 `weekSessionCount only counts sessions with usage in the 7-day window` 用例并断言 merge/finalize 的 `weekSessionCount`。

## D14. 服务商用量随范围重算（会话排行保持全历史）
- **决策**：范围胶囊额外驱动**服务商用量**卡随 7/30/全部 重算；**会话排行保持全历史**（用户明确：会话排行不随范围）。热力图仍固定近半年。
- **原因**：模型可由多个服务商路由，且 provider 是逐 step 的属性（无 model→provider 映射），`UsagePanelState.byProvider` 只有全历史口径、`byDay` 只按 model 分天 → 无「按天×按服务商」数据，7/30 天服务商合计**无法**从既有状态推出，必须扩展持久化状态。
- **实现**：`UsagePanelState` 新增 `byDayProvider`（`day→provider→Buckets`），由 `applyEvent` 的 `commitStep` 与压缩/摘要提交路径经 `addIntoDay` 同步写入；新增纯函数 `providerWindowOf(state, cutoffKey)`（与 `recentOf` 对称，按天×按服务商滚动窗口合计）。`PROJECTION_STATE_VERSION` 由 1 升到 2 → 旧 checkpoint 失效、从日志重新折叠（日志是唯一事实源）。`Aggregate` 新增 `recentByProvider`/`weekByProvider`，`mergeSessionValue` 用两个窗口 cutoff（7d/30d）填充；`finalizeOverview` 输出 `providers`（30d）/ `week.providers`（7d）/ `allTime.providers`（全部）。
- **偏离说明**：契约顶层 `providers` 语义由「全历史」改为「最近 30 天」（与顶层 `totals`/`byModel` 一致），全历史挪入 `allTime.providers`，7 天挪入 `week.providers`；`topSessions` 仍为全历史。`OVERVIEW_VERSION` 由 4 升到 5 使旧缓存失效；`isUsable` 校验 `week.providers` 与 `allTime.providers`。
- **验收**：`tests/projection.test.ts` 新增 `byDayProvider` 折叠 + `providerWindowOf` 窗口用例；`tests/aggregate.test.ts` 新增 `finalizeOverview window-splits providers: 7d vs 30d vs all-time`（构造 08-01/08-14 两会话证明 7d 与 30d 服务商集合不同），并在 `finalizeOverview builds the wire payload` 断言三档 `providers`。

## D15. 种子边界修复：first-marker（取代 D2；v0.2.0 事故热修）
- **事故**：单个反复压缩的长对话，dsh 重启后统计只剩最新上下文窗口。根因：dsh `Session` 构造器对每次 re-seed（含重启重开）都会在已存日志尾部追加新的 `session/end-seed`；"last marker wins"边界把最后一个重启标记之前的一切（本会话自己的已计费历史）判为不可计数。
- **决策**：计费边界 = **第一个** `session/end-seed`（构造种子/fork 边界）；后续标记是生命周期重种子，不移动边界（reducer 分支 `first marker wins`：`seedEnd !== null` 保持原值）。新增纯函数 `seedBoundaryOf(events, seedLength?)` 统一边界：`seedLength > 0`（持久 fork 血缘，v0.1.0 语义）> 第一个标记 > 0（从未 fork，全量计数）；`foldEvents` 预置该边界，scan 路径带 header 走同一函数。
- **偏离说明**：`PROJECTION_STATE_VERSION` 2→3——v2 checkpoint 可能含旧规则算出的偏低总量，必须整行丢弃重折（registry 对 ver 不匹配的行本就丢弃，日志是唯一事实源）；`OVERVIEW_VERSION` 不动（线协议形状未变）。
- **剩余边缘（记录在案）**：投影 unit 无 header 可见——单趟折叠里标记一直不出现则无法武装（无标记新会话在投影模式计 0，直到首次重启留标记；scan 经 `seedLength=0` 全对），且"无头标记"日志下 fork 与重种子不可区分（first-marker 对后者少计）。真实宿主日志带头标记，两路均完全正确。
- **验收**：`tests/projection.test.ts` 新增/改写用例——`a mid-log session/end-seed is a RE-SEED boundary`、`repeated restart re-seeds do not drop a repeatedly compacted conversation`（含单趟 applyEvent 同口径断言）、`fork boundary stays at the first marker across later restart re-seeds`、`a log without any marker … counts everything`、`seedBoundaryOf` 两用例；原 `fork seed … never counted` 用例改写为纯 fork 日志。
