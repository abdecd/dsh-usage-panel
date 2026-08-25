// dsh-usage-panel · fallback scan path (v0.1.0 logic ported to TS).
//
// Used when the sessionProjections / sessionProjectionCache services are
// unavailable: replays every session log through the SAME pure reducer as the
// projection path (single accounting core). Seed boundary = v0.1.0 semantics
// restored: header.seedLength (durable fork lineage) is authoritative when
// > 0; otherwise the FIRST session/end-seed marker; otherwise seq 0. Coverage
// counters replace the old silent `continue`.
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only imports that load the event-map augmentations for merged types.
import type { SessionTitleEventData } from '@deepseek-ai/dsh-session-title'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Overview } from '../shared/contract.ts'
import { mapConcurrent } from '../shared/usage.ts'
import { emptyAggregate, finalizeOverview, mergeSessionValue, type Aggregate } from './aggregate.ts'
import { applyEvent, initState, seedBoundaryOf, type UsagePanelState } from './projection.ts'

export interface ScanFallbackDeps {
  sq: SessionQueryEngine
  providerNames: Record<string, string>
  logFailure: (message: string) => void
}

/** True for events the reducer will count (post-seed usage / retry). */
function isCountedEvent(state: { seedEnd: number | null }, event: SessionEvent): boolean {
  if (state.seedEnd === null || event.seq < state.seedEnd) return false
  switch (event.type) {
    case 'assistant/message':
      return !!event.data.usage
    case 'assistant/chunk':
      return !!event.data.chunk && event.data.chunk.type === 'usage' && !!event.data.chunk.usage
    case 'compaction/summary':
      return !!event.data.usage
    case 'llm/retry':
      return true
    default:
      return false
  }
}

export async function scanFallback(deps: ScanFallbackDeps, now: number): Promise<Overview> {
  const { sq, providerNames, logFailure } = deps
  let a: Aggregate = emptyAggregate()
  const titles = new Map<string, string | null>()
  let sessionsTotal = 0
  let sessionsOk = 0
  let sessionsFailed = 0
  let sessionsPending = 0
  let eventsCounted = 0

  let sessions: SessionRecord[] = []
  try {
    sessions = await sq.listSessions()
  } catch (err) {
    logFailure('listSessions failed: ' + String((err as Error)?.message ?? err))
    return finalizeOverview({
      aggregate: a,
      now,
      mode: 'scan',
      sessionsTotal: 0,
      sessionsOk: 0,
      sessionsFailed: 0,
      sessionsPending: 0,
      eventsCounted: 0,
      titles,
      providerNames,
    })
  }

  const results = await mapConcurrent(sessions, 16, async (rec) => {
    const header = rec && rec.header
    if (!header) {
      return { status: 'failed' as const, err: 'missing header' }
    }
    const sessionId = header.id
    if (!rec.persisted) {
      return { status: 'pending' as const, sessionId }
    }
    let snapshot: { events?: SessionEvent[] } | null = null
    try {
      snapshot = await sq.readSession(sessionId)
    } catch (err) {
      return { status: 'failed' as const, sessionId, err: String((err as Error)?.message ?? err) }
    }
    const events = snapshot && snapshot.events
    if (!events || !events.length) {
      return { status: 'ok' as const, sessionId, title: null, state: initState(), depth: 0, counted: 0 }
    }

    // Seed boundary (seedBoundaryOf): header.seedLength is the DURABLE
    // fork-lineage value — 0 for a session that was never forked, in which
    // case every event is its own billed history, INCLUDING the prefixes
    // between session/end-seed markers (dsh re-seeds a session on every
    // restart and appends a new marker; a "last marker" boundary dropped all
    // pre-restart history of a repeatedly compacted conversation). The FIRST
    // marker only serves headers without seedLength.
    const seedLength = Number((header as { seedLength?: unknown }).seedLength) || 0
    const seedEnd = seedBoundaryOf(events, seedLength)
    let state: UsagePanelState = { ...initState(), seedEnd }

    let title: string | null = null
    let counted = 0
    for (const event of events) {
      if (event.type === 'session/title') {
        title = event.data.title
        // Fall through to the reducer (uninterested → same reference).
      }
      if (isCountedEvent(state, event)) counted += 1
      state = applyEvent(state, event)
    }
    const depth = Number((header as { delegationDepth?: unknown }).delegationDepth) || 0
    return { status: 'ok' as const, sessionId, title, state, depth, counted }
  })

  for (const res of results) {
    sessionsTotal += 1
    if (res.status === 'failed') {
      sessionsFailed += 1
      if (res.err) logFailure('readSession failed: ' + res.err)
    } else if (res.status === 'pending') {
      sessionsPending += 1
    } else {
      sessionsOk += 1
      eventsCounted += res.counted
      if (res.title !== null) titles.set(res.sessionId, res.title)
      a = mergeSessionValue(a, res.state, res.sessionId, now, res.depth)
    }
  }

  return finalizeOverview({
    aggregate: a,
    now,
    mode: 'scan',
    sessionsTotal,
    sessionsOk,
    sessionsFailed,
    sessionsPending,
    eventsCounted,
    titles,
    providerNames,
  })
}
