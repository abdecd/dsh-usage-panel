// src/shared/contract.ts
var RPC_CHANNEL = "/usage-stats";
var RPC_OVERVIEW = "overview";

// src/shared/usage.ts
var HEAT_DAYS = 182;
var RECENT_DAYS = 30;
var WEEK_DAYS = 7;
function emptyBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function emptyTotals() {
  return { ...emptyBuckets(), total: 0 };
}
function totalsFrom(b) {
  return { ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite };
}
function sortedModels(map) {
  return Object.keys(map).map((model) => {
    const b = map[model];
    return { model, ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite };
  }).sort((a, b) => b.total - a.total);
}
function totalsFromModels(models) {
  const totals = emptyTotals();
  for (const item of models) {
    totals.input += item.input;
    totals.output += item.output;
    totals.cacheRead += item.cacheRead;
    totals.cacheWrite += item.cacheWrite;
    totals.total += item.total;
  }
  return totals;
}
function dayKeyUTC(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function parseDayKeyUTC(key) {
  const p = key.split("-");
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}
function keyOfDateUTC(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function todayKeyUTC(now) {
  return dayKeyUTC(now);
}
function buildDayWindow(byDay, now) {
  const days = [];
  const today = todayKeyUTC(now);
  const todayDate = parseDayKeyUTC(today);
  for (let i = HEAT_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), todayDate.getUTCDate() - i));
    const key = keyOfDateUTC(d);
    const record = byDay[key];
    const models = {};
    let total = 0;
    if (record) {
      for (const model of Object.keys(record)) {
        const b = record[model];
        models[model] = totalsFrom(b);
        total += models[model].total;
      }
    }
    days.push({ date: key, total, models });
  }
  return days;
}
async function mapConcurrent(items, limit, fn) {
  const count = items.length;
  if (count === 0) return [];
  const results = new Array(count);
  let cursor = 0;
  const workers = Math.min(Math.max(1, limit), count);
  async function worker() {
    while (cursor < count) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// src/host/projection.ts
import { z } from "zod";
var bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number()
});
var stepSchema = z.object({
  buckets: bucketSchema,
  lastTime: z.number(),
  model: z.string(),
  provider: z.string(),
  mode: z.enum(["provisional", "authoritative"])
});
var usagePanelSchema = z.object({
  totals: bucketSchema,
  byModel: z.record(z.string(), bucketSchema),
  byDay: z.record(z.string(), z.record(z.string(), bucketSchema)),
  byProvider: z.record(z.string(), bucketSchema),
  // Per-day per-provider buckets: lets the host roll provider totals up to a
  // window (7d / 30d) the same way byDay serves the model dimension.
  byDayProvider: z.record(z.string(), z.record(z.string(), bucketSchema)),
  retries: z.number(),
  compactionTokens: z.number(),
  firstTime: z.number().nullable(),
  lastTime: z.number().nullable(),
  seedEnd: z.number().nullable(),
  currentModel: z.string(),
  currentProvider: z.string(),
  openStep: z.string().nullable(),
  steps: z.record(z.string(), stepSchema)
});
var USAGE_PANEL_KEY = "usagePanel";
var EMPTY = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function initState(seedEnd = 0) {
  return {
    totals: { ...EMPTY },
    byModel: {},
    byDay: {},
    byProvider: {},
    byDayProvider: {},
    retries: 0,
    compactionTokens: 0,
    firstTime: null,
    lastTime: null,
    seedEnd,
    currentModel: "unknown",
    currentProvider: "unknown",
    openStep: null,
    steps: {}
  };
}
function stepKey(turn, step) {
  return turn + ":" + step;
}
function routeFromAssistantMessage(event) {
  const source = event.data.message?.source;
  if (!source || source.kind !== "model") return null;
  const provider = typeof source.provider === "string" ? source.provider.trim() : "";
  const model = typeof source.model === "string" ? source.model.trim() : "";
  return provider && model ? { provider, model } : null;
}
function add(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  };
}
function addInto(map, key, b) {
  const cur = map[key];
  return { ...map, [key]: cur ? add(cur, b) : { ...b } };
}
function addIntoDay(byDay, day, model, b) {
  const dayMap = byDay[day];
  return { ...byDay, [day]: dayMap ? addInto(dayMap, model, b) : { [model]: { ...b } } };
}
function isCounted(state, event) {
  return state.seedEnd !== null && event.seq >= state.seedEnd;
}
function touchTime(state, time) {
  if (state.firstTime === null || time < state.firstTime || time > (state.lastTime ?? 0)) {
    return {
      ...state,
      firstTime: state.firstTime === null ? time : Math.min(state.firstTime, time),
      lastTime: state.lastTime === null ? time : Math.max(state.lastTime, time)
    };
  }
  return state;
}
function commitStep(state, key) {
  const step = state.steps[key];
  if (!step) return state;
  const b = step.buckets;
  if (b.input === 0 && b.output === 0 && b.cacheRead === 0 && b.cacheWrite === 0) {
    const steps = { ...state.steps };
    delete steps[key];
    return { ...state, steps, openStep: state.openStep === key ? null : state.openStep };
  }
  const day = dayKeyUTC(step.lastTime);
  const next = {
    ...state,
    totals: add(state.totals, b),
    byModel: addInto(state.byModel, step.model, b),
    byDay: addIntoDay(state.byDay, day, step.model, b),
    byProvider: addInto(state.byProvider, step.provider, b),
    byDayProvider: addIntoDay(state.byDayProvider, day, step.provider, b),
    firstTime: state.firstTime === null ? step.lastTime : Math.min(state.firstTime, step.lastTime),
    lastTime: state.lastTime === null ? step.lastTime : Math.max(state.lastTime, step.lastTime),
    steps: { ...state.steps },
    openStep: state.openStep === key ? null : state.openStep
  };
  delete next.steps[key];
  return next;
}
function commitOpenStep(state, incomingKey) {
  if (state.openStep !== null && state.openStep !== incomingKey) {
    return commitStep(state, state.openStep);
  }
  return state;
}
function applyEvent(state, event) {
  switch (event.type) {
    case "session/end-seed": {
      if (state.seedEnd !== null) return state;
      return { ...state, seedEnd: event.seq };
    }
    case "request/context": {
      const { model, provider } = event.data;
      if (!model && !provider) return state;
      return {
        ...state,
        currentModel: model || state.currentModel,
        currentProvider: provider || state.currentProvider
      };
    }
    case "request/header": {
      const cfg = event.data.header && event.data.header.config;
      if (!cfg || !cfg.model && !cfg.provider) return state;
      return {
        ...state,
        currentModel: cfg.model || state.currentModel,
        currentProvider: cfg.provider || state.currentProvider
      };
    }
    case "assistant/chunk": {
      if (!isCounted(state, event)) return state;
      const chunk = event.data.chunk;
      if (!chunk || chunk.type !== "usage" || !chunk.usage) return state;
      const key = stepKey(event.data.turn, event.data.step);
      const usage = chunk.usage;
      const b = {
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0
      };
      let next = commitOpenStep(state, key);
      const existing = next.steps[key];
      const step = existing ? { ...existing, buckets: add(existing.buckets, b), lastTime: event.time } : {
        buckets: b,
        lastTime: event.time,
        model: next.currentModel,
        provider: next.currentProvider,
        mode: "provisional"
      };
      return {
        ...next,
        steps: { ...next.steps, [key]: step },
        openStep: key
      };
    }
    case "assistant/message": {
      if (!isCounted(state, event)) return state;
      const route = routeFromAssistantMessage(event);
      const routed = route ? { ...state, currentModel: route.model, currentProvider: route.provider } : state;
      const usage = event.data.usage;
      if (!usage) return routed;
      const key = stepKey(event.data.turn, event.data.step);
      const b = {
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0
      };
      let next = commitOpenStep(routed, key);
      const step = {
        buckets: b,
        lastTime: event.time,
        model: next.currentModel,
        provider: next.currentProvider,
        mode: "authoritative"
      };
      return {
        ...next,
        steps: { ...next.steps, [key]: step },
        openStep: key
      };
    }
    case "step/end": {
      const key = stepKey(event.data.turn, event.data.step);
      return commitStep(state, key);
    }
    case "turn/end": {
      return state.openStep !== null ? commitStep(state, state.openStep) : state;
    }
    case "llm/retry": {
      if (!isCounted(state, event)) return state;
      return touchTime({ ...state, retries: state.retries + 1 }, event.time);
    }
    case "compaction/summary": {
      if (!isCounted(state, event)) return state;
      const usage = event.data.usage;
      if (!usage) return state;
      const b = {
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0
      };
      const model = event.data.model || state.currentModel;
      const provider = event.data.provider || state.currentProvider;
      const day = dayKeyUTC(event.time);
      return {
        ...state,
        totals: add(state.totals, b),
        byModel: addInto(state.byModel, model, b),
        byDay: addIntoDay(state.byDay, day, model, b),
        byProvider: addInto(state.byProvider, provider, b),
        byDayProvider: addIntoDay(state.byDayProvider, day, provider, b),
        compactionTokens: state.compactionTokens + b.input + b.output + b.cacheRead + b.cacheWrite,
        firstTime: state.firstTime === null ? event.time : Math.min(state.firstTime, event.time),
        lastTime: state.lastTime === null ? event.time : Math.max(state.lastTime, event.time)
      };
    }
    default:
      return state;
  }
}
function seedBoundaryOf(events, seedLength) {
  if (typeof seedLength === "number") {
    return seedLength > 0 ? seedLength : 0;
  }
  for (const event of events) {
    if (event.type === "session/end-seed") return event.seq;
  }
  return 0;
}
function foldEvents(events, seedLength) {
  const state = { ...initState(), seedEnd: seedBoundaryOf(events, seedLength) };
  let current = state;
  for (const event of events) current = applyEvent(current, event);
  return current;
}
function recentOf(value, cutoffKey) {
  const totals = { ...EMPTY };
  const byModel = {};
  for (const day of Object.keys(value.byDay)) {
    if (day < cutoffKey) continue;
    for (const model of Object.keys(value.byDay[day])) {
      const b = value.byDay[day][model];
      totals.input += b.input;
      totals.output += b.output;
      totals.cacheRead += b.cacheRead;
      totals.cacheWrite += b.cacheWrite;
      const cur = byModel[model];
      byModel[model] = cur ? {
        input: cur.input + b.input,
        output: cur.output + b.output,
        cacheRead: cur.cacheRead + b.cacheRead,
        cacheWrite: cur.cacheWrite + b.cacheWrite
      } : { ...b };
    }
  }
  return { totals, byModel };
}
function providerWindowOf(value, cutoffKey) {
  const out = {};
  const byDay = value.byDayProvider;
  for (const day of Object.keys(byDay)) {
    if (day < cutoffKey) continue;
    for (const provider of Object.keys(byDay[day])) {
      const b = byDay[day][provider];
      const cur = out[provider];
      out[provider] = cur ? {
        input: cur.input + b.input,
        output: cur.output + b.output,
        cacheRead: cur.cacheRead + b.cacheRead,
        cacheWrite: cur.cacheWrite + b.cacheWrite
      } : { ...b };
    }
  }
  return out;
}

// src/host/aggregate.ts
function emptyAggregate() {
  return {
    allTimeTotals: emptyTotals(),
    allTimeByModel: {},
    allTimeByProvider: {},
    byDay: {},
    recentTotals: emptyTotals(),
    recentByModel: {},
    recentByProvider: {},
    weekByProvider: {},
    recentSessionCount: 0,
    weekSessionCount: 0,
    allTimeSessionCount: 0,
    retries: 0,
    compactionTokens: 0,
    from: null,
    to: null,
    usageSessionsMain: 0,
    usageSessionsSubagent: 0,
    sessions: []
  };
}
function mergeSessionValue(a, value, sessionId, now, depth = 0) {
  const cutoffKey = dayKeyUTC(now - RECENT_DAYS * 24 * 3600 * 1e3);
  const recent = recentOf(value, cutoffKey);
  const weekCutoffKey = dayKeyUTC(now - WEEK_DAYS * 24 * 3600 * 1e3);
  const week = recentOf(value, weekCutoffKey);
  const recentProvider = providerWindowOf(value, cutoffKey);
  const weekProvider = providerWindowOf(value, weekCutoffKey);
  const totals = totalsFrom(value.totals);
  const next = {
    ...a,
    allTimeTotals: {
      input: a.allTimeTotals.input + totals.input,
      output: a.allTimeTotals.output + totals.output,
      cacheRead: a.allTimeTotals.cacheRead + totals.cacheRead,
      cacheWrite: a.allTimeTotals.cacheWrite + totals.cacheWrite,
      total: a.allTimeTotals.total + totals.total
    },
    recentTotals: {
      input: a.recentTotals.input + recent.totals.input,
      output: a.recentTotals.output + recent.totals.output,
      cacheRead: a.recentTotals.cacheRead + recent.totals.cacheRead,
      cacheWrite: a.recentTotals.cacheWrite + recent.totals.cacheWrite,
      total: a.recentTotals.total + recent.totals.input + recent.totals.output + recent.totals.cacheRead + recent.totals.cacheWrite
    },
    retries: a.retries + value.retries,
    compactionTokens: a.compactionTokens + value.compactionTokens,
    from: a.from === null ? value.firstTime : value.firstTime === null ? a.from : Math.min(a.from, value.firstTime),
    to: a.to === null ? value.lastTime : value.lastTime === null ? a.to : Math.max(a.to, value.lastTime)
  };
  for (const model of Object.keys(value.byModel)) {
    const b = value.byModel[model];
    const cur = next.allTimeByModel[model];
    next.allTimeByModel[model] = cur ? mergeB(cur, b) : { ...b };
  }
  for (const provider of Object.keys(value.byProvider)) {
    const b = value.byProvider[provider];
    const cur = next.allTimeByProvider[provider];
    next.allTimeByProvider[provider] = cur ? mergeB(cur, b) : { ...b };
  }
  for (const day of Object.keys(value.byDay)) {
    const dayMap = value.byDay[day];
    const target = next.byDay[day] || (next.byDay[day] = {});
    for (const model of Object.keys(dayMap)) {
      const b = dayMap[model];
      const cur = target[model];
      target[model] = cur ? mergeB(cur, b) : { ...b };
    }
  }
  for (const model of Object.keys(recent.byModel)) {
    const b = recent.byModel[model];
    const cur = next.recentByModel[model];
    next.recentByModel[model] = cur ? mergeB(cur, b) : { ...b };
  }
  for (const provider of Object.keys(recentProvider)) {
    const b = recentProvider[provider];
    const cur = next.recentByProvider[provider];
    next.recentByProvider[provider] = cur ? mergeB(cur, b) : { ...b };
  }
  for (const provider of Object.keys(weekProvider)) {
    const b = weekProvider[provider];
    const cur = next.weekByProvider[provider];
    next.weekByProvider[provider] = cur ? mergeB(cur, b) : { ...b };
  }
  if (recent.totals.input + recent.totals.output + recent.totals.cacheRead + recent.totals.cacheWrite > 0) {
    next.recentSessionCount += 1;
  }
  if (week.totals.input + week.totals.output + week.totals.cacheRead + week.totals.cacheWrite > 0) {
    next.weekSessionCount += 1;
  }
  if (totals.total > 0) {
    next.allTimeSessionCount += 1;
    if (depth > 0) next.usageSessionsSubagent += 1;
    else next.usageSessionsMain += 1;
    next.sessions.push({ id: sessionId, totals, lastActive: value.lastTime ?? 0, depth });
  }
  return next;
}
function mergeB(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  };
}
function rankSessions(sessions, limit) {
  return [...sessions].sort((a, b) => b.totals.total - a.totals.total).slice(0, limit);
}
function finalizeOverview(input) {
  const { aggregate: a, now, mode, sessionsTotal, sessionsOk, sessionsFailed, sessionsPending, eventsCounted, titles, providerNames } = input;
  const recentByModel = sortedModels(a.recentByModel);
  const allTimeByModel = sortedModels(a.allTimeByModel);
  const providerRows = (byProvider) => Object.keys(byProvider).map((id) => {
    const b = byProvider[id];
    return { id, name: providerNames[id] || id, totals: totalsFrom(b) };
  }).sort((x, y) => y.totals.total - x.totals.total);
  const top = rankSessions(a.sessions, 10);
  const topSessions = top.map((s) => ({
    id: s.id,
    title: titles.has(s.id) ? titles.get(s.id) : null,
    totals: s.totals,
    lastActive: s.lastActive,
    depth: s.depth
  }));
  const coverage = {
    mode,
    timezone: "UTC",
    sessionsTotal,
    sessionsOk,
    sessionsFailed,
    sessionsPending,
    eventsCounted,
    retries: a.retries,
    compactionTokens: a.compactionTokens,
    from: a.from,
    to: a.to,
    usageSessionsMain: a.usageSessionsMain,
    usageSessionsSubagent: a.usageSessionsSubagent
  };
  return {
    days: buildDayWindow(a.byDay, now),
    totals: totalsFromModels(recentByModel),
    sessionCount: a.recentSessionCount,
    weekSessionCount: a.weekSessionCount,
    byModel: recentByModel,
    providers: providerRows(a.recentByProvider),
    week: {
      providers: providerRows(a.weekByProvider)
    },
    allTime: {
      totals: totalsFromModels(allTimeByModel),
      sessionCount: a.allTimeSessionCount,
      byModel: allTimeByModel,
      providers: providerRows(a.allTimeByProvider)
    },
    coverage,
    topSessions,
    updatedAt: now
  };
}
function emptyOverview(now) {
  return finalizeOverview({
    aggregate: emptyAggregate(),
    now,
    mode: "none",
    sessionsTotal: 0,
    sessionsOk: 0,
    sessionsFailed: 0,
    sessionsPending: 0,
    eventsCounted: 0,
    titles: /* @__PURE__ */ new Map(),
    providerNames: {}
  });
}

// src/host/projection-unit.ts
var PROJECTION_STATE_VERSION = 5;
var usagePanelProjectionDefinition = {
  key: USAGE_PANEL_KEY,
  schema: usagePanelSchema,
  init: initState,
  apply: applyEvent,
  view: (state) => state,
  stateVersion: PROJECTION_STATE_VERSION
};

// src/host/history.ts
import { z as z2 } from "zod";
var sessionIdentitySchema = z2.object({
  id: z2.string(),
  createdAt: z2.number(),
  cwd: z2.string().optional()
});
var usageLedgerRowSchema = z2.object({
  session: sessionIdentitySchema,
  /** Opaque source revision; stable while the raw log is unchanged. */
  revision: z2.string(),
  /** Projection/reducer version used to create `state`. */
  stateVersion: z2.number(),
  state: usagePanelSchema,
  title: z2.string().nullable(),
  depth: z2.number(),
  eventsCounted: z2.number(),
  lastSeq: z2.number(),
  savedAt: z2.number()
});
var usageLedgerDomainSpec = {
  name: "usage_stats",
  version: 1,
  tables: {
    sessions: { valueSchema: usageLedgerRowSchema }
  }
};
function identityKey(id, createdAt, cwd) {
  return encodeURIComponent(JSON.stringify([id, createdAt, cwd ?? null]));
}
function usageLedgerKey(header) {
  return identityKey(String(header.id), header.createdAt, header.cwd);
}
function sameLedgerLifecycle(row, header) {
  return row.session.id === String(header.id) && row.session.createdAt === header.createdAt && row.session.cwd === header.cwd;
}
function titleFromEvents(events) {
  let title = null;
  for (const event of events) {
    if (event.type === "session/title") title = event.data.title;
  }
  return title;
}
function countUsageEvents(events, seedLength) {
  const boundary = seedBoundaryOf(events, seedLength);
  let count = 0;
  for (const event of events) {
    if (event.seq < boundary) continue;
    switch (event.type) {
      case "assistant/message":
        if (event.data.usage) count += 1;
        break;
      case "assistant/chunk":
        if (event.data.chunk && event.data.chunk.type === "usage" && event.data.chunk.usage) count += 1;
        break;
      case "compaction/summary":
        if (event.data.usage) count += 1;
        break;
      case "llm/retry":
        count += 1;
        break;
    }
  }
  return count;
}
function makeUsageLedgerRow(input) {
  const { header, revision, state } = input;
  return {
    session: {
      id: String(header.id),
      createdAt: header.createdAt,
      ...header.cwd === void 0 ? {} : { cwd: header.cwd }
    },
    revision,
    stateVersion: PROJECTION_STATE_VERSION,
    state,
    title: input.title ?? null,
    depth: input.depth ?? (Number(header.delegationDepth) || 0),
    eventsCounted: input.eventsCounted ?? 0,
    lastSeq: input.lastSeq ?? -1,
    savedAt: input.savedAt ?? Date.now()
  };
}
var UsageLedger = class {
  constructor(domain) {
    this.domain = domain;
  }
  tails = /* @__PURE__ */ new Map();
  entries() {
    return [...this.domain.table("sessions").entries()];
  }
  get(key) {
    return this.domain.table("sessions").get(key);
  }
  put(key, row) {
    const table = this.domain.table("sessions");
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => void 0).then(() => table.put(key, structuredClone(row)));
    this.tails.set(key, task);
    void task.then(
      () => {
        if (this.tails.get(key) === task) this.tails.delete(key);
      },
      () => {
        if (this.tails.get(key) === task) this.tails.delete(key);
      }
    );
    return task;
  }
  async close() {
    await Promise.allSettled(this.tails.values());
    await this.domain.close();
  }
};
async function openUsageLedger(storageDomain, logFailure) {
  if (!storageDomain) return null;
  try {
    const domain = await storageDomain.open(usageLedgerDomainSpec);
    return new UsageLedger(domain);
  } catch (err) {
    logFailure("usage history ledger unavailable; continuing without durable deletion retention: " + String(err?.message ?? err));
    return null;
  }
}

// src/host/scan.ts
function seedLengthOf(header) {
  const raw = header.seedLength;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : void 0;
}
function depthOf(header) {
  return Number(header.delegationDepth) || 0;
}
function cachedRowOf(row, header, revision) {
  if (!row || revision === null) return void 0;
  if (!sameLedgerLifecycle(row, header)) return void 0;
  if (row.stateVersion !== PROJECTION_STATE_VERSION || row.revision !== revision) return void 0;
  return row;
}
async function scanFallback(deps, now) {
  const { sq, providerNames, logFailure, ledger, revisions = /* @__PURE__ */ new Map(), liveSessionOf } = deps;
  const entries = ledger ? ledger.entries() : [];
  const rowsByKey = new Map(entries);
  let a = emptyAggregate();
  const titles = /* @__PURE__ */ new Map();
  const currentKeys = /* @__PURE__ */ new Set();
  const seenKeys = /* @__PURE__ */ new Set();
  let sessionsTotal = 0;
  let sessionsOk = 0;
  let sessionsFailed = 0;
  let sessionsPending = 0;
  let eventsCounted = 0;
  let sessions = [];
  try {
    sessions = await sq.listSessions();
  } catch (err) {
    logFailure("listSessions failed: " + String(err?.message ?? err));
    for (const [key, row] of entries) {
      a = mergeSessionValue(a, row.state, row.session.id, now, row.depth);
      titles.set(row.session.id, row.title);
      eventsCounted += row.eventsCounted;
      seenKeys.add(key);
    }
    return finalizeOverview({
      aggregate: a,
      now,
      mode: "scan",
      sessionsTotal: entries.length,
      sessionsOk: entries.length,
      sessionsFailed: 0,
      sessionsPending: 0,
      eventsCounted,
      titles,
      providerNames
    });
  }
  const results = await mapConcurrent(sessions, 16, async (rec) => {
    const header = rec && rec.header;
    if (!header) return { status: "failed", err: "missing header" };
    const sessionId = header.id;
    const key = usageLedgerKey(header);
    currentKeys.add(key);
    const live = rec.live && liveSessionOf ? liveSessionOf(sessionId) : void 0;
    const revision = live ? "live:" + live.seq : revisions.get(key) ?? null;
    const stored = rowsByKey.get(key);
    const cached = cachedRowOf(stored, header, revision);
    const stale = stored && sameLedgerLifecycle(stored, header) ? stored : void 0;
    if (cached) {
      return {
        status: "ok",
        sessionId,
        key,
        title: cached.title,
        state: cached.state,
        depth: cached.depth,
        counted: cached.eventsCounted,
        cached: true
      };
    }
    if (!rec.persisted && !live) return { status: "pending", sessionId, key, fallback: stale };
    try {
      const seedLength = seedLengthOf(header);
      const events = live ? live.events : (await sq.readSession(sessionId)).events;
      const state = foldEvents(events, seedLength);
      const title = titleFromEvents(events);
      const counted = countUsageEvents(events, seedLength);
      const depth = depthOf(header);
      const row = makeUsageLedgerRow({
        header,
        revision: revision ?? "uncached:" + String(events.at(-1)?.seq ?? -1),
        state,
        title,
        depth,
        eventsCounted: counted,
        lastSeq: events.at(-1)?.seq ?? -1
      });
      if (ledger && revision !== null) {
        try {
          await ledger.put(key, row);
          rowsByKey.set(key, row);
        } catch (err) {
          logFailure("usage history write failed: " + String(err?.message ?? err));
        }
      }
      return { status: "ok", sessionId, key, title, state, depth, counted, cached: false };
    } catch (err) {
      return {
        status: "failed",
        sessionId,
        key,
        err: String(err?.message ?? err),
        fallback: stale
      };
    }
  });
  for (const res of results) {
    sessionsTotal += 1;
    if (res.status === "failed") {
      sessionsFailed += 1;
      if (res.err) logFailure("readSession failed: " + res.err);
      if (res.fallback) {
        seenKeys.add(res.key);
        a = mergeSessionValue(a, res.fallback.state, res.sessionId, now, res.fallback.depth);
        titles.set(res.sessionId, res.fallback.title);
        eventsCounted += res.fallback.eventsCounted;
      }
    } else if (res.status === "pending") {
      sessionsPending += 1;
      if (res.fallback) {
        seenKeys.add(res.key);
        a = mergeSessionValue(a, res.fallback.state, res.sessionId, now, res.fallback.depth);
        titles.set(res.sessionId, res.fallback.title);
        eventsCounted += res.fallback.eventsCounted;
      }
    } else {
      seenKeys.add(res.key);
      sessionsOk += 1;
      eventsCounted += res.counted;
      titles.set(res.sessionId, res.title);
      a = mergeSessionValue(a, res.state, res.sessionId, now, res.depth);
    }
  }
  for (const [key, row] of entries) {
    if (seenKeys.has(key)) continue;
    a = mergeSessionValue(a, row.state, row.session.id, now, row.depth);
    titles.set(row.session.id, row.title);
    eventsCounted += row.eventsCounted;
    if (!currentKeys.has(key)) {
      sessionsTotal += 1;
      sessionsOk += 1;
    }
  }
  return finalizeOverview({
    aggregate: a,
    now,
    mode: "scan",
    sessionsTotal,
    sessionsOk,
    sessionsFailed,
    sessionsPending,
    eventsCounted,
    titles,
    providerNames
  });
}

// src/host/index.ts
var name = "dsh-usage-panel";
var inject = ["timer", "connection"];
var STALE_MS = 10 * 60 * 1e3;
var RESCAN_MS = 10 * 60 * 1e3;
function apply(ctx) {
  const tag = "[dsh-usage-panel]";
  const sq = ctx.get("sessionQuery");
  const registry = ctx.get("sessionProjections");
  const projCache = ctx.get("sessionProjectionCache");
  const connection = ctx.get("connection");
  const llm = ctx.get("llm");
  const storageDomain = ctx.get("storageDomain");
  const persistence = ctx.get("sessionPersistence");
  const sessionStore = ctx.get("sessions");
  let mode = registry && projCache && sq ? "projection" : sq ? "scan" : "none";
  console.log(
    tag,
    "boot: mode=" + mode,
    "services: sessionQuery=" + Boolean(sq) + " sessionProjections=" + Boolean(registry) + " sessionProjectionCache=" + Boolean(projCache) + " storageDomain=" + Boolean(storageDomain) + " sessionPersistence=" + Boolean(persistence)
  );
  let disposeUnit = null;
  if (mode === "projection") {
    try {
      disposeUnit = registry.register(usagePanelProjectionDefinition);
    } catch (err) {
      console.warn(tag, "projection registration failed; falling back to full scan:", String(err?.message ?? err));
      disposeUnit = null;
      mode = "scan";
    }
  }
  let providerNames = {};
  if (llm && typeof llm.listProviders === "function") {
    Promise.resolve(llm.listProviders()).then((infos) => {
      providerNames = Object.fromEntries((infos || []).map((p) => [p.id, p.name]));
    }).catch((err) => console.warn(tag, "listProviders failed:", String(err?.message ?? err)));
  }
  let cache = null;
  let inflight = null;
  let disposed = false;
  function logFailure(message) {
    console.warn(tag, message);
  }
  let cacheGeneration = 0;
  const historyReady = openUsageLedger(storageDomain, logFailure);
  const liveCaptureTails = /* @__PURE__ */ new Map();
  const liveTitles = /* @__PURE__ */ new Map();
  function seedLengthOf2(header) {
    const raw = header.seedLength;
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : void 0;
  }
  function depthOf2(header) {
    return Number(header.delegationDepth) || 0;
  }
  function titleOfLive(session) {
    const key = usageLedgerKey(session.header);
    if (liveTitles.has(key)) return liveTitles.get(key) ?? null;
    const title = titleFromEvents(session.events);
    liveTitles.set(key, title);
    return title;
  }
  function invalidateOverview() {
    cache = null;
    cacheGeneration += 1;
  }
  function liveSessionOf(id) {
    return sessionStore ? sessionStore.get(id) : void 0;
  }
  function revisionOf(rec, revisions) {
    const key = usageLedgerKey(rec.header);
    const live = rec.live ? liveSessionOf(rec.header.id) : void 0;
    if (live) return { key, revision: "live:" + live.seq, live };
    return { key, revision: revisions.get(key) ?? null, live };
  }
  async function listRevisions() {
    const result = /* @__PURE__ */ new Map();
    if (!persistence || typeof persistence.listSnapshots !== "function") return result;
    try {
      const snapshots = await persistence.listSnapshots();
      for (const snapshot of snapshots) {
        if (snapshot && snapshot.header && typeof snapshot.revision === "string") {
          result.set(usageLedgerKey(snapshot.header), snapshot.revision);
        }
      }
    } catch (err) {
      logFailure("session persistence revision listing failed; active sessions will be read conservatively: " + String(err?.message ?? err));
    }
    return result;
  }
  function cachedRowOf2(row, header, revision) {
    if (!row || revision === null) return void 0;
    if (!sameLedgerLifecycle(row, header)) return void 0;
    if (row.stateVersion !== PROJECTION_STATE_VERSION || row.revision !== revision) return void 0;
    return row;
  }
  function mergeRetainedRows(aggregate, entries, seen, currentKeys, now, titles) {
    let next = aggregate;
    let count = 0;
    for (const [key, row] of entries) {
      if (seen.has(key)) continue;
      next = mergeSessionValue(next, row.state, row.session.id, now, row.depth);
      titles.set(row.session.id, row.title);
      if (!currentKeys.has(key)) count += 1;
    }
    return { aggregate: next, count };
  }
  async function saveLedgerRow(ledger, key, row) {
    try {
      await ledger.put(key, row);
    } catch (err) {
      logFailure("usage history write failed: " + String(err?.message ?? err));
    }
  }
  function captureLiveSession(session) {
    const key = usageLedgerKey(session.header);
    const previous = liveCaptureTails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => void 0).then(async () => {
      const ledger = await historyReady;
      if (!ledger || disposed) return;
      const seedLength = seedLengthOf2(session.header);
      let state;
      if (mode === "projection" && registry && !(seedLength && seedLength > 0)) {
        state = registry.snapshot(session).values.usagePanel ?? foldEvents(session.events, seedLength);
      } else {
        state = foldEvents(session.events, seedLength);
      }
      const projectionBacked = mode === "projection" && registry && !(seedLength && seedLength > 0);
      await saveLedgerRow(
        ledger,
        key,
        makeUsageLedgerRow({
          header: session.header,
          revision: "live:" + session.seq,
          state,
          title: titleOfLive(session),
          depth: depthOf2(session.header),
          eventsCounted: projectionBacked ? 0 : countUsageEvents(session.events, seedLength),
          lastSeq: session.seq - 1
        })
      );
    }).catch((err) => logFailure("usage history capture failed: " + String(err?.message ?? err)));
    liveCaptureTails.set(key, task);
    void task.then(
      () => {
        if (liveCaptureTails.get(key) === task) liveCaptureTails.delete(key);
      },
      () => {
        if (liveCaptureTails.get(key) === task) liveCaptureTails.delete(key);
      }
    );
    return task;
  }
  async function overviewFromLedger(now) {
    const ledger = await historyReady;
    if (!ledger) return emptyOverview(now);
    const titles = /* @__PURE__ */ new Map();
    let aggregate = emptyAggregate();
    let eventsCounted = 0;
    const entries = ledger.entries();
    for (const [_key, row] of entries) {
      aggregate = mergeSessionValue(aggregate, row.state, row.session.id, now, row.depth);
      titles.set(row.session.id, row.title);
      eventsCounted += row.eventsCounted;
    }
    return finalizeOverview({
      aggregate,
      now,
      mode: "scan",
      sessionsTotal: entries.length,
      sessionsOk: entries.length,
      sessionsFailed: 0,
      sessionsPending: 0,
      eventsCounted,
      titles,
      providerNames
    });
  }
  ctx.on("session/event", (session, event) => {
    if (event.type === "session/title") liveTitles.set(usageLedgerKey(session.header), event.data.title);
    if (event.type === "turn/end") {
      invalidateOverview();
      void captureLiveSession(session);
    }
  });
  ctx.on("session/flush", (session) => {
    invalidateOverview();
    return captureLiveSession(session);
  });
  ctx.on("session/disposed", (session) => {
    invalidateOverview();
    void captureLiveSession(session).then(() => liveTitles.delete(usageLedgerKey(session.header)));
  });
  async function scanProjection(now) {
    const ledger = await historyReady;
    const revisions = ledger ? await listRevisions() : /* @__PURE__ */ new Map();
    const entries = ledger ? ledger.entries() : [];
    const rowsByKey = new Map(entries);
    let a = emptyAggregate();
    let sessionsTotal = 0;
    let sessionsOk = 0;
    let sessionsFailed = 0;
    let sessionsPending = 0;
    const failures = [];
    const titles = /* @__PURE__ */ new Map();
    let sessions = [];
    try {
      sessions = await sq.listSessions();
    } catch (err) {
      logFailure("listSessions failed: " + String(err?.message ?? err));
      const retained2 = mergeRetainedRows(a, entries, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), now, titles);
      return finalizeOverview({
        aggregate: retained2.aggregate,
        now,
        mode: "projection",
        sessionsTotal: retained2.count,
        sessionsOk: retained2.count,
        sessionsFailed: 0,
        sessionsPending: 0,
        eventsCounted: 0,
        titles,
        providerNames
      });
    }
    const currentKeys = /* @__PURE__ */ new Set();
    const seenKeys = /* @__PURE__ */ new Set();
    const results = await mapConcurrent(sessions, 16, async (rec) => {
      const header = rec && rec.header;
      if (!header) return { status: "failed", err: "missing header" };
      const id = header.id;
      const meta = revisionOf(rec, revisions);
      currentKeys.add(meta.key);
      const stored = rowsByKey.get(meta.key);
      const cached = cachedRowOf2(stored, header, meta.revision);
      const stale = stored && sameLedgerLifecycle(stored, header) ? stored : void 0;
      if (cached) {
        return {
          status: "ok",
          id,
          key: meta.key,
          value: cached.state,
          depth: cached.depth,
          title: cached.title,
          counted: cached.eventsCounted,
          cached: true
        };
      }
      if (!rec.persisted && !meta.live) {
        return { status: "pending", id, key: meta.key, fallback: stale };
      }
      const seedLength = seedLengthOf2(header);
      const depth = depthOf2(header);
      try {
        let value;
        let title = null;
        let counted = 0;
        let lastSeq = -1;
        if (seedLength !== void 0 && seedLength > 0) {
          const events = meta.live ? meta.live.events : (await sq.readSession(id)).events;
          value = foldEvents(events, seedLength);
          title = titleFromEvents(events);
          counted = countUsageEvents(events, seedLength);
          lastSeq = events.at(-1)?.seq ?? -1;
        } else if (meta.live) {
          if (registry) value = registry.snapshot(meta.live).values.usagePanel;
          if (!value) value = foldEvents(meta.live.events, seedLength);
          title = titleFromEvents(meta.live.events);
          counted = countUsageEvents(meta.live.events, seedLength);
          lastSeq = meta.live.seq - 1;
        } else {
          const snap = await projCache.coldSnapshot(id);
          value = snap.values.usagePanel;
          lastSeq = snap.asOfSeq;
          if (!value) return { status: "pending", id, key: meta.key, fallback: stale };
        }
        if (!value) return { status: "pending", id, key: meta.key, fallback: stale };
        if (ledger && meta.revision !== null) {
          const row = makeUsageLedgerRow({
            header,
            revision: meta.revision,
            state: value,
            title,
            depth,
            eventsCounted: counted,
            lastSeq
          });
          await saveLedgerRow(ledger, meta.key, row);
          rowsByKey.set(meta.key, row);
        }
        return { status: "ok", id, key: meta.key, value, depth, title, counted, cached: false };
      } catch (err) {
        return {
          status: "failed",
          id,
          key: meta.key,
          err: String(err?.message ?? err),
          fallback: stale
        };
      }
    });
    for (const res of results) {
      sessionsTotal += 1;
      if (res.status === "failed") {
        sessionsFailed += 1;
        if (res.err && failures.length < 3) failures.push(res.err);
        if (res.fallback) {
          seenKeys.add(res.key);
          a = mergeSessionValue(a, res.fallback.state, res.id, now, res.fallback.depth);
          titles.set(res.id, res.fallback.title);
        }
      } else if (res.status === "pending") {
        sessionsPending += 1;
        if (res.fallback) {
          seenKeys.add(res.key);
          a = mergeSessionValue(a, res.fallback.state, res.id, now, res.fallback.depth);
          titles.set(res.id, res.fallback.title);
        }
      } else {
        sessionsOk += 1;
        seenKeys.add(res.key);
        a = mergeSessionValue(a, res.value, res.id, now, res.depth);
        titles.set(res.id, res.title);
      }
    }
    const retained = mergeRetainedRows(a, entries, seenKeys, currentKeys, now, titles);
    a = retained.aggregate;
    sessionsTotal += retained.count;
    sessionsOk += retained.count;
    if (failures.length > 0) {
      logFailure(sessionsFailed + " session(s) failed to read (first " + failures.length + "): " + failures.join(" | "));
    }
    await Promise.all(
      rankSessions(a.sessions, 10).map(async (s) => {
        if (titles.has(s.id) && titles.get(s.id) !== null) return;
        try {
          const t = await sq.readTitle(s.id);
          titles.set(s.id, t ? t.title : null);
        } catch {
          titles.set(s.id, null);
        }
      })
    );
    return finalizeOverview({
      aggregate: a,
      now,
      mode: "projection",
      sessionsTotal,
      sessionsOk,
      sessionsFailed,
      sessionsPending,
      eventsCounted: 0,
      titles,
      providerNames
    });
  }
  async function scan(now) {
    if (disposed) return cache ? cache.payload : emptyOverview(now);
    if (mode === "none") {
      console.log(tag, "sessionQuery unavailable; serving retained usage ledger if present");
      return overviewFromLedger(now);
    }
    if (mode === "projection") return scanProjection(now);
    const ledger = await historyReady;
    const revisions = ledger ? await listRevisions() : /* @__PURE__ */ new Map();
    return scanFallback({
      sq,
      providerNames,
      logFailure,
      ledger,
      revisions,
      liveSessionOf
    }, now);
  }
  function startScan() {
    if (disposed) return Promise.resolve(cache ? cache.payload : emptyOverview(Date.now()));
    if (inflight) return inflight;
    const generation = cacheGeneration;
    const run = scan(Date.now()).then((payload) => {
      if (!disposed && generation === cacheGeneration) cache = { at: Date.now(), payload };
      return payload;
    });
    inflight = run;
    run.catch(() => {
    }).then(() => {
      if (inflight === run) inflight = null;
    });
    return run;
  }
  function overview(args) {
    const force = !!(args && args.force);
    if (!force && cache) {
      if (Date.now() - cache.at < STALE_MS) return Promise.resolve(cache.payload);
      startScan();
      return Promise.resolve(Object.assign({}, cache.payload, { stale: true }));
    }
    return startScan();
  }
  const disposeRpc = connection && connection.rpc.handle(
    RPC_CHANNEL,
    (endpoint, payload) => {
      if (endpoint === RPC_OVERVIEW) {
        return overview(payload).then(
          (value) => ({ ok: true, value }),
          (err) => ({
            ok: false,
            error: {
              code: "internal",
              message: String(err?.message ?? err),
              details: {}
            }
          })
        );
      }
      return Promise.resolve({
        ok: false,
        error: { code: "bad-request", message: "unknown endpoint: " + String(endpoint), details: { issues: [] } }
      });
    },
    { authority: "loopback" }
  );
  startScan().then((o) => {
    console.log(
      tag,
      "first scan done:",
      "mode=" + o.coverage.mode,
      "sessions=" + o.coverage.sessionsTotal + "/" + o.coverage.sessionsOk + " (failed " + o.coverage.sessionsFailed + ", pending " + o.coverage.sessionsPending + ")",
      "withUsage=" + o.allTime.sessionCount,
      "dataRange=" + (o.coverage.from === null ? "-" : new Date(o.coverage.from).toISOString()) + ".." + (o.coverage.to === null ? "-" : new Date(o.coverage.to).toISOString())
    );
  });
  const stopTimer = ctx.interval(() => {
    if (!inflight) startScan();
  }, RESCAN_MS);
  ctx.effect(() => async () => {
    disposed = true;
    if (disposeUnit) disposeUnit();
    if (stopTimer) stopTimer();
    if (disposeRpc) disposeRpc();
    const ledger = await historyReady;
    if (ledger) {
      try {
        await ledger.close();
      } catch (err) {
        logFailure("usage history ledger close failed: " + String(err?.message ?? err));
      }
    }
  });
}
export {
  apply,
  inject,
  name
};
