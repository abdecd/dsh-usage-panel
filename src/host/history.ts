// dsh-usage-panel · durable session statistics ledger.
//
// sessionProjectionCache is a fold accelerator for sessions that still exist in
// the session corpus. This ledger is a different thing: it is the independent
// historical source for usage statistics. Rows are never removed when a
// conversation is archived or its raw session log is deleted.
import { z } from 'zod'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { seedBoundaryOf, usagePanelSchema, type UsagePanelState } from './projection.ts'
import { PROJECTION_STATE_VERSION } from './projection-unit.ts'

const sessionIdentitySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  cwd: z.string().optional(),
})

export const usageLedgerRowSchema = z.object({
  session: sessionIdentitySchema,
  /** Opaque source revision; stable while the raw log is unchanged. */
  revision: z.string(),
  /** Projection/reducer version used to create `state`. */
  stateVersion: z.number(),
  state: usagePanelSchema,
  title: z.string().nullable(),
  depth: z.number(),
  eventsCounted: z.number(),
  lastSeq: z.number(),
  savedAt: z.number(),
})

export type UsageLedgerRow = z.infer<typeof usageLedgerRowSchema>

/**
 * This is deliberately a plain DomainSpec literal. It keeps the storage
 * domain an optional runtime capability: when storage-domain is not mounted,
 * the plugin can still use its existing projection/scan paths without a
 * top-level runtime import of the optional host package.
 */
export const usageLedgerDomainSpec = {
  name: 'usage_stats',
  version: 1,
  tables: {
    sessions: { valueSchema: usageLedgerRowSchema },
  },
} satisfies DomainSpec

interface LedgerTable {
  get(key: string): UsageLedgerRow | undefined
  entries(): IterableIterator<[string, UsageLedgerRow]>
  put(key: string, value: UsageLedgerRow): Promise<void>
}

interface LedgerDomain extends Pick<Domain<typeof usageLedgerDomainSpec>, 'close'> {
  table(name: 'sessions'): LedgerTable
}

export interface StorageDomainLike {
  open<S extends DomainSpec>(spec: S): Promise<LedgerDomain & Domain<S>>
}

/** Stable key for one Session id + one durable log lifecycle. */
function identityKey(id: string, createdAt: number, cwd: string | undefined): string {
  // JSON + URI encoding avoids collisions when an id or cwd contains a
  // separator. A recreated id with a new createdAt gets a new historical row.
  return encodeURIComponent(JSON.stringify([id, createdAt, cwd ?? null]))
}

export function usageLedgerKey(header: SessionHeader): string {
  return identityKey(String(header.id), header.createdAt, header.cwd)
}

export function sameLedgerLifecycle(row: UsageLedgerRow, header: SessionHeader): boolean {
  return (
    row.session.id === String(header.id) &&
    row.session.createdAt === header.createdAt &&
    row.session.cwd === header.cwd
  )
}

/** Extract the latest durable title without making another log read. */
export function titleFromEvents(events: readonly SessionEvent[]): string | null {
  let title: string | null = null
  for (const event of events) {
    if (event.type === 'session/title') title = event.data.title
  }
  return title
}

/**
 * Count usage-bearing events using the same boundary and event vocabulary as
 * the fallback scan. This is diagnostic only; token totals come from state.
 */
export function countUsageEvents(events: readonly SessionEvent[], seedLength?: number): number {
  const boundary = seedBoundaryOf(events, seedLength)
  let count = 0
  for (const event of events) {
    if (event.seq < boundary) continue
    switch (event.type) {
      case 'assistant/message':
        if (event.data.usage) count += 1
        break
      case 'assistant/chunk':
        if (event.data.chunk && event.data.chunk.type === 'usage' && event.data.chunk.usage) count += 1
        break
      case 'compaction/summary':
        if (event.data.usage) count += 1
        break
      case 'llm/retry':
        count += 1
        break
    }
  }
  return count
}

export function makeUsageLedgerRow(input: {
  header: SessionHeader
  revision: string
  state: UsagePanelState
  title?: string | null
  depth?: number
  eventsCounted?: number
  lastSeq?: number
  savedAt?: number
}): UsageLedgerRow {
  const { header, revision, state } = input
  return {
    session: {
      id: String(header.id),
      createdAt: header.createdAt,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    },
    revision,
    stateVersion: PROJECTION_STATE_VERSION,
    state,
    title: input.title ?? null,
    depth: input.depth ?? (Number((header as { delegationDepth?: unknown }).delegationDepth) || 0),
    eventsCounted: input.eventsCounted ?? 0,
    lastSeq: input.lastSeq ?? -1,
    savedAt: input.savedAt ?? Date.now(),
  }
}

/**
 * An opened durable ledger. The per-key queue prevents a scan write and a live
 * event write from interleaving for the same session lifecycle.
 */
export class UsageLedger {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly domain: LedgerDomain) {}

  entries(): Array<[string, UsageLedgerRow]> {
    return [...this.domain.table('sessions').entries()]
  }

  get(key: string): UsageLedgerRow | undefined {
    return this.domain.table('sessions').get(key)
  }

  put(key: string, row: UsageLedgerRow): Promise<void> {
    const table = this.domain.table('sessions')
    const previous = this.tails.get(key) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() => table.put(key, structuredClone(row)))
    this.tails.set(key, task)
    void task.then(
      () => {
        if (this.tails.get(key) === task) this.tails.delete(key)
      },
      () => {
        if (this.tails.get(key) === task) this.tails.delete(key)
      },
    )
    return task
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.tails.values())
    await this.domain.close()
  }
}

export async function openUsageLedger(
  storageDomain: StorageDomainLike | undefined,
  logFailure: (message: string) => void,
): Promise<UsageLedger | null> {
  if (!storageDomain) return null
  try {
    const domain = await storageDomain.open(usageLedgerDomainSpec)
    return new UsageLedger(domain)
  } catch (err) {
    logFailure('usage history ledger unavailable; continuing without durable deletion retention: ' + String((err as Error)?.message ?? err))
    return null
  }
}
