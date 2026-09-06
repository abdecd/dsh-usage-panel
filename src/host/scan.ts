// dsh-usage-panel · fallback scan path (v0.1.0 logic ported to TS).
//
// Used when the sessionProjections / sessionProjectionCache services are
// unavailable: folds through the SAME pure reducer as the projection path
// (single accounting core). The durable usage_stats ledger is checked first;
// only a missing or changed persistence revision replays a session log. Seed
// boundary = header.seedLength (durable fork lineage), otherwise the FIRST
// session/end-seed marker, otherwise seq 0. Coverage counters replace the old
// silent `continue`.
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only imports that load the event-map augmentations for merged types.
import type { SessionTitleEventData } from '@deepseek-ai/dsh-session-title'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Overview } from '../shared/contract.ts'
import { mapConcurrent } from '../shared/usage.ts'
import { emptyAggregate, finalizeOverview, mergeSessionValue, type Aggregate } from './aggregate.ts'
import { foldEvents } from './projection.ts'
import { PROJECTION_STATE_VERSION } from './projection-unit.ts'
import {
  countUsageEvents,
  makeUsageLedgerRow,
  sameLedgerLifecycle,
  titleFromEvents,
  usageLedgerKey,
  type UsageLedger,
  type UsageLedgerRow,
} from './history.ts'

export interface ScanFallbackDeps {
  sq: SessionQueryEngine
  providerNames: Record<string, string>
  logFailure: (message: string) => void
  ledger?: UsageLedger | null
  revisions?: ReadonlyMap<string, string>
  liveSessionOf?: (id: SessionId) => Session | undefined
}


function depthOf(header: SessionRecord['header']): number {
  return Number((header as { delegationDepth?: unknown }).delegationDepth) || 0
}

function cachedRowOf(
  row: UsageLedgerRow | undefined,
  header: SessionRecord['header'],
  revision: string | null,
): UsageLedgerRow | undefined {
  if (!row || revision === null) return undefined
  if (!sameLedgerLifecycle(row, header)) return undefined
  // A fallback row made by a previous reducer version is still retained as a
  // historical fallback, but it must not seed a new calculation.
  if (row.stateVersion !== PROJECTION_STATE_VERSION || row.revision !== revision) return undefined
  return row
}

export async function scanFallback(deps: ScanFallbackDeps, now: number): Promise<Overview> {
  const { sq, providerNames, logFailure, ledger, revisions = new Map(), liveSessionOf } = deps
  const entries = ledger ? ledger.entries() : []
  const rowsByKey = new Map(entries)
  let a: Aggregate = emptyAggregate()
  const titles = new Map<string, string | null>()
  const currentKeys = new Set<string>()
  const seenKeys = new Set<string>()
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
    for (const [key, row] of entries) {
      a = mergeSessionValue(a, row.state, row.session.id, now, row.depth)
      titles.set(row.session.id, row.title)
      eventsCounted += row.eventsCounted
      seenKeys.add(key)
    }
    return finalizeOverview({
      aggregate: a,
      now,
      mode: 'scan',
      sessionsTotal: entries.length,
      sessionsOk: entries.length,
      sessionsFailed: 0,
      sessionsPending: 0,
      eventsCounted,
      titles,
      providerNames,
    })
  }

  const results = await mapConcurrent(sessions, 16, async (rec) => {
    const header = rec && rec.header
    if (!header) return { status: 'failed' as const, err: 'missing header' }

    const sessionId = header.id
    const key = usageLedgerKey(header)
    currentKeys.add(key)
    const live = rec.live && liveSessionOf ? liveSessionOf(sessionId) : undefined
    const revision = live ? 'live:' + live.seq : revisions.get(key) ?? null
    const stored = rowsByKey.get(key)
    const cached = cachedRowOf(stored, header, revision)
    const stale = stored && sameLedgerLifecycle(stored, header) ? stored : undefined
    if (cached) {
      return {
        status: 'ok' as const,
        sessionId,
        key,
        title: cached.title,
        state: cached.state,
        depth: cached.depth,
        counted: cached.eventsCounted,
        cached: true,
      }
    }

    if (!rec.persisted && !live) return { status: 'pending' as const, sessionId, key, fallback: stale }

    try {
      const snapshot = live ? null : await sq.readSession(sessionId)
      const seedLength = live ? live.inheritedEventCount : snapshot!.inheritedEventCount
      const events = live ? live.snapshotEvents() : snapshot!.events
      const state = foldEvents(events, seedLength)
      const title = titleFromEvents(events)
      const counted = countUsageEvents(events, seedLength)
      const depth = depthOf(header)
      const row = makeUsageLedgerRow({
        header,
        revision: revision ?? 'uncached:' + String(events.at(-1)?.seq ?? -1),
        state,
        title,
        depth,
        eventsCounted: counted,
        lastSeq: events.at(-1)?.seq ?? -1,
      })
      if (ledger && revision !== null) {
        try {
          await ledger.put(key, row)
          rowsByKey.set(key, row)
        } catch (err) {
          // The ledger is an optimization/retention sidecar; a write failure
          // must not turn a successfully folded session into a scan failure.
          logFailure('usage history write failed: ' + String((err as Error)?.message ?? err))
        }
      }
      return { status: 'ok' as const, sessionId, key, title, state, depth, counted, cached: false }
    } catch (err) {
      return {
        status: 'failed' as const,
        sessionId,
        key,
        err: String((err as Error)?.message ?? err),
        fallback: stale,
      }
    }
  })

  for (const res of results) {
    sessionsTotal += 1
    if (res.status === 'failed') {
      sessionsFailed += 1
      if (res.err) logFailure('readSession failed: ' + res.err)
      if (res.fallback) {
        seenKeys.add(res.key!)
        a = mergeSessionValue(a, res.fallback.state, res.sessionId!, now, res.fallback.depth)
        titles.set(res.sessionId!, res.fallback.title)
        eventsCounted += res.fallback.eventsCounted
      }
    } else if (res.status === 'pending') {
      sessionsPending += 1
      if (res.fallback) {
        seenKeys.add(res.key!)
        a = mergeSessionValue(a, res.fallback.state, res.sessionId!, now, res.fallback.depth)
        titles.set(res.sessionId!, res.fallback.title)
        eventsCounted += res.fallback.eventsCounted
      }
    } else {
      seenKeys.add(res.key)
      sessionsOk += 1
      eventsCounted += res.counted
      titles.set(res.sessionId, res.title)
      a = mergeSessionValue(a, res.state, res.sessionId, now, res.depth)
    }
  }

  // A ledger row is intentionally retained even when the source session no
  // longer appears in sessionQuery (archive or physical log deletion).
  for (const [key, row] of entries) {
    if (seenKeys.has(key)) continue
    a = mergeSessionValue(a, row.state, row.session.id, now, row.depth)
    titles.set(row.session.id, row.title)
    eventsCounted += row.eventsCounted
    if (!currentKeys.has(key)) {
      sessionsTotal += 1
      sessionsOk += 1
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
