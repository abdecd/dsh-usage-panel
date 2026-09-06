// dsh-usage-panel · Host face (web plugin entry).
//
// Data path: the sessionProjections persisted projection is the primary
// source — every session's events are folded incrementally by the framework
// (four disjoint buckets, fork dedup, stream/retry/compaction semantics) and
// checkpoints are durable. An independent usage_stats ledger stores the
// calculated per-session result keyed by the persistence revision, so an
// unchanged conversation is not recalculated and its history survives removal
// of the original log. When projection services are unavailable the same
// ledger makes the fallback scan revision-aware.
//
// Reads are served with stale-while-revalidate: fresh for 10 minutes; older
// payloads return instantly with `stale: true` while a background rescan
// refreshes; the refresh button forces a synchronous scan. Original session
// logs remain read-only; only the derived usage ledger is written.
import type { Context } from '@deepseek-ai/cordis'
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'
import { RPC_CHANNEL, RPC_OVERVIEW, type CoverageStats, type Overview, type RpcResult } from '../shared/contract.ts'
import { mapConcurrent } from '../shared/usage.ts'
import { emptyAggregate, emptyOverview, finalizeOverview, mergeSessionValue, rankSessions } from './aggregate.ts'
import { foldEvents, type UsagePanelState } from './projection.ts'
import { PROJECTION_STATE_VERSION, usagePanelProjectionDefinition } from './projection-unit.ts'
import {
  countUsageEvents,
  makeUsageLedgerRow,
  openUsageLedger,
  sameLedgerLifecycle,
  titleFromEvents,
  usageLedgerKey,
  type StorageDomainLike,
  type UsageLedger,
  type UsageLedgerRow,
} from './history.ts'
import { scanFallback } from './scan.ts'
import type { HostConnection, HostLlm } from './types.ts'

export const name = 'dsh-usage-panel'
export const inject = ['timer', 'connection']

const STALE_MS = 10 * 60 * 1000 // cache freshness window
const RESCAN_MS = 10 * 60 * 1000 // periodic keep-warm rescan

interface PersistenceSnapshotLike {
  header: SessionRecord['header']
  revision: unknown
}

interface SessionPersistenceLike {
  listSnapshots?: () => Promise<readonly PersistenceSnapshotLike[]>
}

export function apply(ctx: Context): void {
  const tag = '[dsh-usage-panel]'
  const sq = ctx.get('sessionQuery') as SessionQueryEngine | undefined
  const registry = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
  const projCache = ctx.get('sessionProjectionCache') as SessionProjectionCache | undefined
  const connection = ctx.get('connection') as HostConnection | undefined
  const llm = ctx.get('llm') as HostLlm | undefined
  const storageDomain = ctx.get('storageDomain') as StorageDomainLike | undefined
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  const sessionStore = ctx.get('sessions') as SessionStore | undefined

  let mode: CoverageStats['mode'] =
    registry && projCache && sq ? 'projection' : sq ? 'scan' : 'none'

  console.log(
    tag,
    'boot: mode=' + mode,
    'services: sessionQuery=' + Boolean(sq) + ' sessionProjections=' + Boolean(registry) + ' sessionProjectionCache=' + Boolean(projCache) + ' storageDomain=' + Boolean(storageDomain) + ' sessionPersistence=' + Boolean(persistence),
  )

  // Registration is an effect on this fiber: the unit's key disappears when
  // the plugin unloads. Fail-soft: any registration problem drops to scan.
  let disposeUnit: (() => void) | null = null
  if (mode === 'projection') {
    try {
      disposeUnit = registry!.register(usagePanelProjectionDefinition)
    } catch (err) {
      console.warn(tag, 'projection registration failed; falling back to full scan:', String((err as Error)?.message ?? err))
      disposeUnit = null
      mode = 'scan'
    }
  }

  let providerNames: Record<string, string> = {}
  if (llm && typeof llm.listProviders === 'function') {
    Promise.resolve(llm.listProviders())
      .then((infos) => {
        providerNames = Object.fromEntries((infos || []).map((p) => [p.id, p.name]))
      })
      .catch((err) => console.warn(tag, 'listProviders failed:', String((err as Error)?.message ?? err)))
  }

  let cache: { at: number; payload: Overview } | null = null
  let inflight: Promise<Overview> | null = null
  let disposed = false

  function logFailure(message: string): void {
    console.warn(tag, message)
  }

  let cacheGeneration = 0

  const historyReady = openUsageLedger(storageDomain, logFailure)
  const liveCaptureTails = new Map<string, Promise<void>>()
  const liveTitles = new Map<string, string | null>()


  function depthOf(header: SessionRecord['header']): number {
    return Number((header as { delegationDepth?: unknown }).delegationDepth) || 0
  }

  function titleOfLive(session: Session): string | null {
    const key = usageLedgerKey(session.header)
    if (liveTitles.has(key)) return liveTitles.get(key) ?? null
    const title = titleFromEvents(session.snapshotEvents())
    liveTitles.set(key, title)
    return title
  }

  function invalidateOverview(): void {
    cache = null
    cacheGeneration += 1
  }

  function liveSessionOf(id: SessionId): Session | undefined {
    return sessionStore ? sessionStore.get(id) : undefined
  }

  function revisionOf(
    rec: SessionRecord,
    revisions: ReadonlyMap<string, string>,
  ): { key: string; revision: string | null; live: Session | undefined } {
    const key = usageLedgerKey(rec.header)
    const live = rec.live ? liveSessionOf(rec.header.id) : undefined
    if (live) return { key, revision: 'live:' + live.seq, live }
    return { key, revision: revisions.get(key) ?? null, live }
  }

  async function listRevisions(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (!persistence || typeof persistence.listSnapshots !== 'function') return result
    try {
      const snapshots = await persistence.listSnapshots()
      for (const snapshot of snapshots) {
        if (snapshot && snapshot.header && typeof snapshot.revision === 'string') {
          result.set(usageLedgerKey(snapshot.header), snapshot.revision)
        }
      }
    } catch (err) {
      logFailure('session persistence revision listing failed; active sessions will be read conservatively: ' + String((err as Error)?.message ?? err))
    }
    return result
  }

  function cachedRowOf(
    row: UsageLedgerRow | undefined,
    header: SessionRecord['header'],
    revision: string | null,
  ): UsageLedgerRow | undefined {
    if (!row || revision === null) return undefined
    if (!sameLedgerLifecycle(row, header)) return undefined
    if (row.stateVersion !== PROJECTION_STATE_VERSION || row.revision !== revision) return undefined
    return row
  }

  function mergeRetainedRows(
    aggregate: ReturnType<typeof emptyAggregate>,
    entries: readonly [string, UsageLedgerRow][],
    seen: ReadonlySet<string>,
    currentKeys: ReadonlySet<string>,
    now: number,
    titles: Map<string, string | null>,
  ): { aggregate: ReturnType<typeof emptyAggregate>; count: number } {
    let next = aggregate
    let count = 0
    for (const [key, row] of entries) {
      if (seen.has(key)) continue
      next = mergeSessionValue(next, row.state, row.session.id, now, row.depth)
      titles.set(row.session.id, row.title)
      if (!currentKeys.has(key)) count += 1
    }
    return { aggregate: next, count }
  }

  async function saveLedgerRow(ledger: UsageLedger, key: string, row: UsageLedgerRow): Promise<void> {
    try {
      await ledger.put(key, row)
    } catch (err) {
      // Statistics computation remains usable if the optional durable sidecar
      // is temporarily unavailable; the next scan/capture retries the write.
      logFailure('usage history write failed: ' + String((err as Error)?.message ?? err))
    }
  }

  function captureLiveSession(session: Session): Promise<void> {
    const key = usageLedgerKey(session.header)
    const previous = liveCaptureTails.get(key) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const ledger = await historyReady
        if (!ledger || disposed) return

        const seedLength = session.inheritedEventCount
        let state: UsagePanelState
        if (mode === 'projection' && registry && !(seedLength && seedLength > 0)) {
          state = registry.snapshot(session).values.usagePanel ?? foldEvents(session.snapshotEvents(), seedLength)
        } else {
          state = foldEvents(session.snapshotEvents(), seedLength)
        }
        const projectionBacked = mode === 'projection' && registry && !(seedLength && seedLength > 0)
        await saveLedgerRow(
          ledger,
          key,
          makeUsageLedgerRow({
            header: session.header,
            revision: 'live:' + session.seq,
            state,
            title: titleOfLive(session),
            depth: depthOf(session.header),
            eventsCounted: projectionBacked ? 0 : countUsageEvents(session.snapshotEvents(), seedLength),
            lastSeq: session.seq - 1,
          }),
        )
      })
      .catch((err) => logFailure('usage history capture failed: ' + String((err as Error)?.message ?? err)))
    liveCaptureTails.set(key, task)
    void task.then(
      () => {
        if (liveCaptureTails.get(key) === task) liveCaptureTails.delete(key)
      },
      () => {
        if (liveCaptureTails.get(key) === task) liveCaptureTails.delete(key)
      },
    )
    return task
  }

  async function overviewFromLedger(now: number): Promise<Overview> {
    const ledger = await historyReady
    if (!ledger) return emptyOverview(now)
    const titles = new Map<string, string | null>()
    let aggregate = emptyAggregate()
    let eventsCounted = 0
    const entries = ledger.entries()
    for (const [_key, row] of entries) {
      aggregate = mergeSessionValue(aggregate, row.state, row.session.id, now, row.depth)
      titles.set(row.session.id, row.title)
      eventsCounted += row.eventsCounted
    }
    return finalizeOverview({
      aggregate,
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

  // Capture at the same durability checkpoints used by session persistence,
  // and one last time when a live session is detached. The ledger is kept even
  // after the source log disappears.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title') liveTitles.set(usageLedgerKey(session.header), event.data.title)
    if (event.type === 'turn/end') {
      invalidateOverview()
      void captureLiveSession(session)
    }
  })
  ctx.on('session/flush', (session) => {
    invalidateOverview()
    return captureLiveSession(session)
  })
  ctx.on('session/disposed', (session) => {
    invalidateOverview()
    void captureLiveSession(session).then(() => liveTitles.delete(usageLedgerKey(session.header)))
  })

  async function scanProjection(now: number): Promise<Overview> {
    const ledger = await historyReady
    const revisions = ledger ? await listRevisions() : new Map<string, string>()
    const entries = ledger ? ledger.entries() : []
    const rowsByKey = new Map(entries)
    let a = emptyAggregate()
    let sessionsTotal = 0
    let sessionsOk = 0
    let sessionsFailed = 0
    let sessionsPending = 0
    const failures: string[] = []
    const titles = new Map<string, string | null>()
    let sessions: SessionRecord[] = []
    try {
      sessions = await sq!.listSessions()
    } catch (err) {
      logFailure('listSessions failed: ' + String((err as Error)?.message ?? err))
      const retained = mergeRetainedRows(a, entries, new Set(), new Set(), now, titles)
      return finalizeOverview({
        aggregate: retained.aggregate,
        now,
        mode: 'projection',
        sessionsTotal: retained.count,
        sessionsOk: retained.count,
        sessionsFailed: 0,
        sessionsPending: 0,
        eventsCounted: 0,
        titles,
        providerNames,
      })
    }

    const currentKeys = new Set<string>()
    const seenKeys = new Set<string>()
    const results = await mapConcurrent(sessions, 16, async (rec) => {
      const header = rec && rec.header
      if (!header) return { status: 'failed' as const, err: 'missing header' }

      const id = header.id
      const meta = revisionOf(rec, revisions)
      currentKeys.add(meta.key)
      const stored = rowsByKey.get(meta.key)
      const cached = cachedRowOf(stored, header, meta.revision)
      const stale = stored && sameLedgerLifecycle(stored, header) ? stored : undefined
      if (cached) {
        return {
          status: 'ok' as const,
          id,
          key: meta.key,
          value: cached.state,
          depth: cached.depth,
          title: cached.title,
          counted: cached.eventsCounted,
          cached: true,
        }
      }

      // A live session has an in-memory source even before its first durable
      // log write. If it has no source at all, retain the old pending behavior.
      if (!rec.persisted && !meta.live) {
        return { status: 'pending' as const, id, key: meta.key, fallback: stale }
      }

      const depth = depthOf(header)
      try {
        let value: UsagePanelState | undefined
        let title: string | null = null
        let counted = 0
        let lastSeq = -1

        if (meta.live) {
          const events = meta.live.snapshotEvents()
          const inheritedEventCount = meta.live.inheritedEventCount
          if (registry) value = registry.snapshot(meta.live).values.usagePanel
          if (!value) value = foldEvents(events, inheritedEventCount)
          title = titleFromEvents(events)
          counted = countUsageEvents(events, inheritedEventCount)
          lastSeq = meta.live.seq - 1
        } else {
          // rc.1 coldSnapshot consumes one validated observation, not a session id.
          // Keep its header, lineage and events together to avoid torn fork cuts.
          const log = await sq!.readSession(id)
          const snap = projCache!.coldSnapshot(log.session, log.inheritedEventCount, log.events)
          value = snap.values.usagePanel
          title = titleFromEvents(log.events)
          counted = countUsageEvents(log.events, log.inheritedEventCount)
          lastSeq = snap.asOfSeq
        }

        if (!value) return { status: 'pending' as const, id, key: meta.key, fallback: stale }
        if (ledger && meta.revision !== null) {
          const row = makeUsageLedgerRow({
            header,
            revision: meta.revision,
            state: value,
            title,
            depth,
            eventsCounted: counted,
            lastSeq,
          })
          await saveLedgerRow(ledger, meta.key, row)
          rowsByKey.set(meta.key, row)
        }
        return { status: 'ok' as const, id, key: meta.key, value, depth, title, counted, cached: false }
      } catch (err) {
        return {
          status: 'failed' as const,
          id,
          key: meta.key,
          err: String((err as Error)?.message ?? err),
          fallback: stale,
        }
      }
    })

    for (const res of results) {
      sessionsTotal += 1
      if (res.status === 'failed') {
        sessionsFailed += 1
        if (res.err && failures.length < 3) failures.push(res.err)
        if (res.fallback) {
          seenKeys.add(res.key!)
          a = mergeSessionValue(a, res.fallback.state, res.id!, now, res.fallback.depth)
          titles.set(res.id!, res.fallback.title)
        }
      } else if (res.status === 'pending') {
        sessionsPending += 1
        if (res.fallback) {
          seenKeys.add(res.key!)
          a = mergeSessionValue(a, res.fallback.state, res.id!, now, res.fallback.depth)
          titles.set(res.id!, res.fallback.title)
        }
      } else {
        sessionsOk += 1
        seenKeys.add(res.key)
        a = mergeSessionValue(a, res.value, res.id, now, res.depth)
        titles.set(res.id, res.title)
      }
    }

    const retained = mergeRetainedRows(a, entries, seenKeys, currentKeys, now, titles)
    a = retained.aggregate
    sessionsTotal += retained.count
    sessionsOk += retained.count

    if (failures.length > 0) {
      logFailure(sessionsFailed + ' session(s) failed to read (first ' + failures.length + '): ' + failures.join(' | '))
    }
    await Promise.all(
      rankSessions(a.sessions, 10).map(async (s) => {
        if (titles.has(s.id) && titles.get(s.id) !== null) return
        try {
          const t = await sq!.readTitle(s.id as SessionId)
          titles.set(s.id, t ? t.title : null)
        } catch {
          titles.set(s.id, null)
        }
      }),
    )
    return finalizeOverview({
      aggregate: a,
      now,
      mode: 'projection',
      sessionsTotal,
      sessionsOk,
      sessionsFailed,
      sessionsPending,
      eventsCounted: 0,
      titles,
      providerNames,
    })
  }

  async function scan(now: number): Promise<Overview> {
    if (disposed) return cache ? cache.payload : emptyOverview(now)
    if (mode === 'none') {
      console.log(tag, 'sessionQuery unavailable; serving retained usage ledger if present')
      return overviewFromLedger(now)
    }
    if (mode === 'projection') return scanProjection(now)
    const ledger = await historyReady
    const revisions = ledger ? await listRevisions() : new Map<string, string>()
    return scanFallback({
      sq: sq!,
      providerNames,
      logFailure,
      ledger,
      revisions,
      liveSessionOf,
    }, now)
  }

  function startScan(): Promise<Overview> {
    if (disposed) return Promise.resolve(cache ? cache.payload : emptyOverview(Date.now()))
    if (inflight) return inflight
    const generation = cacheGeneration
    const run = scan(Date.now()).then((payload) => {
      if (!disposed && generation === cacheGeneration) cache = { at: Date.now(), payload }
      return payload
    })
    inflight = run
    run.catch(() => {}).then(() => {
      if (inflight === run) inflight = null
    })
    return run
  }

  function overview(args: { force?: boolean } | undefined): Promise<Overview> {
    const force = !!(args && args.force)
    if (!force && cache) {
      if (Date.now() - cache.at < STALE_MS) return Promise.resolve(cache.payload)
      startScan() // stale-while-revalidate: background refresh
      return Promise.resolve(Object.assign({}, cache.payload, { stale: true }))
    }
    return startScan()
  }

  // RPC channel for the browser half: /usage-stats/overview.
  const disposeRpc =
    connection &&
    connection.rpc.handle(
      RPC_CHANNEL,
      (endpoint, payload): Promise<RpcResult<Overview>> => {
        if (endpoint === RPC_OVERVIEW) {
          return overview(payload as { force?: boolean } | undefined).then(
            (value) => ({ ok: true, value }),
            (err) => ({
              ok: false,
              error: {
                code: 'internal',
                message: String((err as Error)?.message ?? err),
                details: {},
              },
            }),
          )
        }
        return Promise.resolve({
          ok: false,
          error: { code: 'bad-request', message: 'unknown endpoint: ' + String(endpoint), details: { issues: [] } },
        })
      },
      { authority: 'loopback' },
    )

  // Warm up the moment the plugin loads.
  startScan().then((o) => {
    console.log(
      tag,
      'first scan done:',
      'mode=' + o.coverage.mode,
      'sessions=' + o.coverage.sessionsTotal + '/' + o.coverage.sessionsOk + ' (failed ' + o.coverage.sessionsFailed + ', pending ' + o.coverage.sessionsPending + ')',
      'withUsage=' + o.allTime.sessionCount,
      'dataRange=' + (o.coverage.from === null ? '-' : new Date(o.coverage.from).toISOString()) + '..' + (o.coverage.to === null ? '-' : new Date(o.coverage.to).toISOString()),
    )
  })

  // Keep-warm: light periodic rescan so the cached payload never goes stale.
  const stopTimer = ctx.interval(() => {
    if (!inflight) startScan()
  }, RESCAN_MS)

  ctx.effect(() => async () => {
    disposed = true
    if (disposeUnit) disposeUnit()
    if (stopTimer) stopTimer()
    if (disposeRpc) disposeRpc()
    const ledger = await historyReady
    if (ledger) {
      try {
        await ledger.close()
      } catch (err) {
        logFailure('usage history ledger close failed: ' + String((err as Error)?.message ?? err))
      }
    }
  })
}
