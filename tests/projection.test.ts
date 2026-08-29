// Locks the projection reducer's accounting semantics: seed boundary (fork
// dedup), dual-source model attribution, per-step provisional/authoritative
// replacement (retry dedup), compaction attribution, retry counting, disjoint
// buckets, and the same-reference contract for unrelated events.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyEvent, foldEvents, initState, providerWindowOf, recentOf, seedBoundaryOf } from '../src/host/projection.ts'

function ev(type: string, seq: number, time: number, data: unknown): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

/** Realistic logs start with the constructor's session/end-seed marker. */
function withMarker(events: SessionEvent[]): SessionEvent[] {
  const marker = ev('session/end-seed', 1, 0, {})
  return [marker, ...events.map((e) => ({ ...e, seq: e.seq + 1 }))]
}

function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

test('fork seed (events before the FIRST marker) is never counted; live events after are', () => {
  // No leading marker: a pure fork log — parent history, the constructor
  // marker at the fork boundary, then the child's live events.
  const events = [
    ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 1, 1000, { turn: 1, step: 1 }),
    ev('session/end-seed', 2, 1000, {}),
    ev('assistant/message', 3, 2000, { turn: 1, step: 2, usage: usage(7) }),
    ev('step/end', 4, 2000, { turn: 1, step: 2 }),
  ]
  const state = foldEvents(events)
  assert.equal(state.totals.input, 7)
  assert.equal(state.seedEnd, 2)
})

test('a mid-log session/end-seed is a RE-SEED boundary: the prefix still counts', () => {
  // withMarker => leading constructor marker; the mid-log marker is what dsh
  // appends when the session is re-opened after a restart. Both windows are
  // this session's own billed history and both count (v0.2.0 "last marker"
  // bug: only the window after the LAST marker survived a restart).
  const events = [
    ev('assistant/message', 1, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
    ev('session/end-seed', 3, 2000, {}),
    ev('assistant/message', 4, 2000, { turn: 2, step: 1, usage: usage(7) }),
    ev('step/end', 5, 2000, { turn: 2, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.seedEnd, 1)
  assert.equal(state.totals.input, 107)
})

test('repeated restart re-seeds do not drop a repeatedly compacted conversation', () => {
  // One long-lived conversation: creation marker, work, compaction, restart
  // re-seed markers appended by dsh, more work. ALL of it counts.
  const events = [
    ev('session/end-seed', 0, 0, {}),
    ev('assistant/message', 1, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
    ev('compaction/summary', 3, 2000, {
      compactionId: 'c1', summary: [], shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2],
      shadowedTokenCount: 50, provider: 'p', model: 'compactor', usage: usage(6, 1),
    }),
    ev('session/end-seed', 4, 2000, {}), // dsh restart re-seed
    ev('assistant/message', 5, 3000, { turn: 2, step: 1, usage: usage(40) }),
    ev('step/end', 6, 3000, { turn: 2, step: 1 }),
    ev('session/end-seed', 7, 4000, {}), // another restart
    ev('assistant/message', 8, 4000, { turn: 3, step: 1, usage: usage(50) }),
    ev('step/end', 9, 4000, { turn: 3, step: 1 }),
    ev('compaction/summary', 10, 5000, {
      compactionId: 'c2', summary: [], shadowedRange: { start: 5, end: 6 }, shadowedSeqs: [5, 6],
      shadowedTokenCount: 90, provider: 'p', model: 'compactor', usage: usage(8, 2),
    }),
  ]
  const state = foldEvents(events)
  assert.equal(state.seedEnd, 0)
  assert.equal(state.totals.input, 204) // 100 + 6 + 40 + 50 + 8 — nothing dropped
  assert.equal(state.compactionTokens, 6 + 1 + 8 + 2)
  assert.equal(state.byModel['compactor']?.input, 14)
  // Single-pass fold (the registry's cold/live cell shape) must agree.
  let live = initState()
  for (const event of events) live = applyEvent(live, event)
  assert.equal(live.seedEnd, 0)
  assert.equal(live.totals.input, 204)
  assert.equal(live.compactionTokens, 17)
})

test('fork boundary stays at the first marker across later restart re-seeds', () => {
  // Parent history (excluded — billed under the parent), fork marker, child
  // history, then a restart re-seed of the CHILD: the child keeps its full
  // history, the parent's prefix stays excluded.
  const events = [
    ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 1, 1000, { turn: 1, step: 1 }),
    ev('session/end-seed', 2, 1000, {}), // fork boundary
    ev('assistant/message', 3, 2000, { turn: 1, step: 1, usage: usage(7) }),
    ev('step/end', 4, 2000, { turn: 1, step: 1 }),
    ev('session/end-seed', 5, 3000, {}), // child restarted later
    ev('assistant/message', 6, 3000, { turn: 2, step: 1, usage: usage(50) }),
    ev('step/end', 7, 3000, { turn: 2, step: 1 }),
  ]
  const state = foldEvents(events)
  assert.equal(state.seedEnd, 2)
  assert.equal(state.totals.input, 57) // child's 7 + 50; parent's 100 excluded
})

test('a log without any marker (never forked) counts everything from seq 0', () => {
  const events = [
    ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(10) }),
    ev('step/end', 1, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(events)
  assert.equal(state.seedEnd, 0)
  assert.equal(state.totals.input, 10)
})

test('seedBoundaryOf: seedLength >= 0 is authoritative over markers', () => {
  const events = [
    ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('session/end-seed', 5, 1000, {}),
    ev('session/end-seed', 9, 1000, {}),
  ]
  assert.equal(seedBoundaryOf(events, 5), 5) // durable fork lineage
  assert.equal(seedBoundaryOf(events, 3), 3) // header value wins over the marker
  assert.equal(seedBoundaryOf(events, 0), 0) // seedLength = 0 means unforked, ignores restart marker
  assert.equal(seedBoundaryOf(events, undefined), 5)
  assert.equal(seedBoundaryOf(events), 5)
})

test('forked conversation with parent leading marker correctly excludes parent history', () => {
  // Parent session had a creation marker at seq 0, then message at seq 1.
  // Child is forked at seq 2, gets child's fork marker at seq 2, child message at seq 3.
  const events = [
    ev('session/end-seed', 0, 1000, {}), // parent creation marker
    ev('assistant/message', 1, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
    ev('session/end-seed', 3, 2000, {}), // fork boundary
    ev('assistant/message', 4, 2000, { turn: 1, step: 1, usage: usage(7) }),
    ev('step/end', 5, 2000, { turn: 1, step: 1 }),
  ]
  // With header seedLength = 3 (the exact fork boundary):
  const state = foldEvents(events, 3)
  assert.equal(state.seedEnd, 3)
  assert.equal(state.totals.input, 7) // parent's 100 is excluded!
})

test('nested fork (fork of a fork) excludes all ancestral history', () => {
  const events = [
    ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 1, 1000, { turn: 1, step: 1 }),
    ev('session/end-seed', 2, 1000, {}), // fork 1
    ev('assistant/message', 3, 2000, { turn: 1, step: 1, usage: usage(50) }),
    ev('step/end', 4, 2000, { turn: 1, step: 1 }),
    ev('session/end-seed', 5, 2000, {}), // fork 2
    ev('assistant/message', 6, 3000, { turn: 1, step: 1, usage: usage(15) }),
    ev('step/end', 7, 3000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(events, 5)
  assert.equal(state.seedEnd, 5)
  assert.equal(state.totals.input, 15) // only child 2's usage
})

test('seedBoundaryOf: first marker, else 0', () => {
  const events = [
    ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(100) }),
    ev('session/end-seed', 2, 1000, {}),
    ev('session/end-seed', 7, 1000, {}),
  ]
  assert.equal(seedBoundaryOf(events), 2) // FIRST marker, not the last
  const noMarker = [ev('assistant/message', 0, 1000, { turn: 1, step: 1, usage: usage(1) })]
  assert.equal(seedBoundaryOf(noMarker), 0)
})

test('model attribution: request/context base, request/header overrides (v0.1.0)', () => {
  const events = [
    ev('request/context', 1, 1000, { provider: 'p1', model: 'context-model' }),
    ev('assistant/message', 2, 1000, { turn: 1, step: 1, usage: usage(10) }),
    ev('request/header', 3, 1000, { header: { config: { provider: 'p1', model: 'header-model' } }, reason: 'change' }),
    ev('assistant/message', 4, 1000, { turn: 1, step: 2, usage: usage(20) }),
    ev('step/end', 5, 1000, { turn: 1, step: 2 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.byModel['context-model']?.input, 10)
  assert.equal(state.byModel['header-model']?.input, 20)
  assert.equal(state.byProvider['p1']?.input, 30)
})

test('legacy assistant message provenance recovers the route without request metadata', () => {
  const events = [
    ev('assistant/message', 1, 1000, {
      turn: 1,
      step: 1,
      message: { source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.7-flash' } },
      usage: usage(10, 2, 30),
    }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.deepEqual(state.byModel['gemini-3.7-flash'], { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 })
  assert.deepEqual(state.byProvider.antigravity, { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 })
  assert.equal(state.byModel.unknown, undefined)
  assert.equal(state.byProvider.unknown, undefined)
})

test('assistant message provenance overrides a stale request route for its step', () => {
  const events = [
    ev('request/context', 1, 1000, { provider: 'old-provider', model: 'old-model' }),
    ev('assistant/message', 2, 1000, {
      turn: 1,
      step: 1,
      message: { source: { kind: 'model', provider: 'new-provider', model: 'new-model' } },
      usage: usage(7),
    }),
    ev('step/end', 3, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.byModel['old-model'], undefined)
  assert.equal(state.byProvider['old-provider'], undefined)
  assert.equal(state.byModel['new-model']?.input, 7)
  assert.equal(state.byProvider['new-provider']?.input, 7)
  assert.equal(state.currentModel, 'new-model')
  assert.equal(state.currentProvider, 'new-provider')
})

test('chunk provisional accumulates and is replaced by the authoritative message', () => {
  const events = [
    ev('assistant/chunk', 1, 1000, { turn: 1, step: 1, chunk: { type: 'usage', usage: usage(10, 2) } }),
    ev('assistant/chunk', 2, 1000, { turn: 1, step: 1, chunk: { type: 'usage', usage: usage(5, 1) } }),
    ev('assistant/message', 3, 1000, { turn: 1, step: 1, usage: usage(100, 30) }),
    ev('step/end', 4, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  // Authoritative replaces the accumulated provisional: 100/30, not 115/33.
  assert.deepEqual(state.totals, { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 })
})

test('same-step retried message replaces instead of double-counting (v0.1.0 bug)', () => {
  const events = [
    ev('assistant/message', 1, 1000, { turn: 1, step: 1, usage: usage(50) }),
    ev('llm/retry', 2, 1000, { turn: 1, step: 1, retryId: 'r1', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 2, delayMs: 100, failure: { code: 'x', message: 'x' } }),
    ev('assistant/message', 3, 1000, { turn: 1, step: 1, usage: usage(80) }),
    ev('step/end', 4, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.totals.input, 80) // 80, not 130
  assert.equal(state.retries, 1)
})

test('distinct steps both count (each attempt is a real billed call)', () => {
  const events = [
    ev('assistant/message', 1, 1000, { turn: 1, step: 1, usage: usage(10) }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
    ev('assistant/message', 3, 1000, { turn: 1, step: 2, usage: usage(20) }),
    ev('step/end', 4, 1000, { turn: 1, step: 2 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.totals.input, 30)
})

test('step/end commits a provisional-only step (aborted stream still billed)', () => {
  const events = [
    ev('assistant/chunk', 1, 1000, { turn: 1, step: 1, chunk: { type: 'usage', usage: usage(9) } }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.totals.input, 9)
})

test('turn/end commits the open step (log ends mid-step safety)', () => {
  const events = [
    ev('assistant/chunk', 1, 1000, { turn: 1, step: 3, chunk: { type: 'usage', usage: usage(4) } }),
    ev('turn/end', 2, 1000, { turn: 1, reason: 'success' }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.totals.input, 4)
})

test('compaction/summary usage attributed to its own model and tracked separately', () => {
  const events = [
    ev('compaction/summary', 1, 1000, { compactionId: 'c1', summary: [], shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 50, provider: 'p', model: 'compactor', usage: usage(6, 1, 2, 3) }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.byModel['compactor']?.input, 6)
  assert.equal(state.compactionTokens, 12)
  assert.equal(state.totals.input, 6)
  assert.equal(state.totals.output + state.totals.cacheRead + state.totals.cacheWrite + state.totals.input, 12)
})

test('reasoning is already inside output — never added again', () => {
  const events = [
    ev('assistant/message', 1, 1000, { turn: 1, step: 1, usage: { ...usage(10, 20), reasoningTokens: 15 } }),
    ev('step/end', 2, 1000, { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.totals.output, 20)
  assert.equal(state.totals.input + state.totals.output, 30)
})

test('unrelated events return the SAME state reference (zero downstream work)', () => {
  const state = initState()
  const next = applyEvent(state, ev('user/message', 1, 1000, { content: 'hi' }))
  assert.equal(next, state)
  // Unknown event types are ignored too.
  const next2 = applyEvent(state, ev('todo/write', 2, 1000, { todos: [] }))
  assert.equal(next2, state)
})

test('request/context without model/provider is a no-op (same reference)', () => {
  const state = initState()
  const next = applyEvent(state, ev('request/context', 1, 1000, {}))
  assert.equal(next, state)
})

test('day buckets are UTC and per-model', () => {
  const events = [
    ev('assistant/message', 1, Date.UTC(2026, 7, 15, 23, 30), { turn: 1, step: 1, usage: usage(5) }),
    ev('step/end', 2, Date.UTC(2026, 7, 15, 23, 30), { turn: 1, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.ok(state.byDay['2026-08-15'])
  assert.equal(state.byDay['2026-08-15']!['unknown']!.input, 5)
})

test('byDayProvider buckets per-day per-provider and providerWindowOf sums a window', () => {
  const events = [
    ev('request/context', 1, Date.UTC(2026, 6, 1), { provider: 'p1', model: 'm' }),
    ev('assistant/message', 2, Date.UTC(2026, 6, 1), { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 3, Date.UTC(2026, 6, 1), { turn: 1, step: 1 }),
    ev('request/context', 4, Date.UTC(2026, 7, 14), { provider: 'p2', model: 'm' }),
    ev('assistant/message', 5, Date.UTC(2026, 7, 14), { turn: 2, step: 1, usage: usage(7) }),
    ev('step/end', 6, Date.UTC(2026, 7, 14), { turn: 2, step: 1 }),
  ]
  const state = foldEvents(withMarker(events))
  assert.equal(state.byDayProvider['2026-07-01']?.['p1']?.input, 100)
  assert.equal(state.byDayProvider['2026-08-14']?.['p2']?.input, 7)
  const recent = providerWindowOf(state, '2026-07-16')
  assert.equal(recent['p1'], undefined) // p1 (07-01) is outside the window
  assert.equal(recent['p2']?.input, 7)
  const all = providerWindowOf(state, '2026-01-01')
  assert.equal(all['p1']?.input, 100)
  assert.equal(all['p2']?.input, 7)
})

test('recentOf sums only days >= cutoff key', () => {
  const state = foldEvents(withMarker([
    ev('assistant/message', 1, Date.UTC(2026, 6, 1, 0, 0), { turn: 1, step: 1, usage: usage(100) }),
    ev('step/end', 2, Date.UTC(2026, 6, 1, 0, 0), { turn: 1, step: 1 }),
    ev('assistant/message', 3, Date.UTC(2026, 7, 14, 0, 0), { turn: 2, step: 1, usage: usage(7) }),
    ev('step/end', 4, Date.UTC(2026, 7, 14, 0, 0), { turn: 2, step: 1 }),
  ]))
  const recent = recentOf(state, '2026-07-16')
  assert.equal(recent.totals.input, 7)
  const all = recentOf(state, '2026-01-01')
  assert.equal(all.totals.input, 107)
})

test('firstTime/lastTime track the counted event range', () => {
  const state = foldEvents(withMarker([
    ev('assistant/message', 1, 5000, { turn: 1, step: 1, usage: usage(1) }),
    ev('step/end', 2, 5000, { turn: 1, step: 1 }),
    ev('llm/retry', 3, 9000, { turn: 1, step: 2, retryId: 'r', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 1, delayMs: 1, failure: { code: 'x', message: 'x' } }),
  ]))
  assert.equal(state.firstTime, 5000)
  assert.equal(state.lastTime, 9000)
})

test('unknown non-usage plugin events pass through unchanged', () => {
  const initial = foldEvents(withMarker([
    ev('assistant/message', 1, 5000, { turn: 1, step: 1, usage: usage(10) }),
    ev('step/end', 2, 5000, { turn: 1, step: 1 }),
  ]))
  const next = applyEvent(initial, ev('custom-plugin/metadata', 3, 6000, {
    custom: true,
  }))
  assert.equal(next, initial)
  assert.equal(next.totals.input, 10)
})
