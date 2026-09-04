// Locks the durable statistics-ledger behavior: revision cache hits, per-session
// invalidation, and retention of rows whose raw sessions disappear.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { foldEvents } from '../src/host/projection.ts'
import {
  makeUsageLedgerRow,
  usageLedgerKey,
  type UsageLedger,
  type UsageLedgerRow,
} from '../src/host/history.ts'
import { scanFallback } from '../src/host/scan.ts'

function header(id: string, createdAt: number): SessionRecord['header'] {
  return { id, createdAt, cwd: '/tmp', version: 1 } as unknown as SessionRecord['header']
}

function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 1_000 + seq, data } as unknown as SessionEvent
}

function log(input: number): SessionEvent[] {
  return [
    event('session/end-seed', 0, {}),
    event('assistant/message', 1, { turn: 1, step: 1, usage: { inputTokens: input } }),
    event('step/end', 2, { turn: 1, step: 1 }),
  ]
}

function fakeLedger(initial: Array<[string, UsageLedgerRow]>): UsageLedger {
  const rows = new Map(initial)
  return {
    entries: () => [...rows.entries()],
    get: (key) => rows.get(key),
    put: async (key, row) => {
      rows.set(key, row)
    },
  } as unknown as UsageLedger
}

test('unchanged sessions are reused, changed sessions alone are refolded, deleted rows remain', async () => {
  const a = header('a', 1)
  const b = header('b', 2)
  const deleted = header('deleted', 3)
  const aKey = usageLedgerKey(a)
  const bKey = usageLedgerKey(b)
  const deletedKey = usageLedgerKey(deleted)
  const aState = foldEvents(log(10))
  const deletedState = foldEvents(log(30))
  const ledger = fakeLedger([
    [aKey, makeUsageLedgerRow({ header: a, revision: 'a-1', state: aState, eventsCounted: 1 })],
    [deletedKey, makeUsageLedgerRow({ header: deleted, revision: 'deleted-1', state: deletedState, eventsCounted: 1 })],
  ])
  let reads = 0
  let bInput = 20
  const bEvents = () => log(bInput)
  const sq = {
    listSessions: async () => [
      { header: a, live: false, persisted: true },
      { header: b, live: false, persisted: true },
    ],
    readSession: async (id: string) => {
      reads += 1
      assert.equal(id, 'b')
      return { session: b, events: bEvents() }
    },
  }
  const revisions = new Map<string, string>([
    [aKey, 'a-1'],
    [bKey, 'b-1'],
  ])
  const deps = {
    sq: sq as never,
    providerNames: {},
    logFailure: () => undefined,
    ledger,
    revisions,
  }

  const first = await scanFallback(deps, Date.UTC(2026, 7, 15))
  assert.equal(reads, 1, 'only the uncached session is read')
  assert.equal(first.coverage.sessionsTotal, 3, 'the deleted ledger row is still a session')
  assert.equal(first.allTime.totals.input, 60)

  await scanFallback(deps, Date.UTC(2026, 7, 15))
  assert.equal(reads, 1, 'a second scan reads no unchanged session')

  bInput = 40
  revisions.set(bKey, 'b-2')
  const changed = await scanFallback(deps, Date.UTC(2026, 7, 15))
  assert.equal(reads, 2, 'only the session whose revision changed is read again')
  assert.equal(changed.allTime.totals.input, 80)
  assert.equal(changed.coverage.sessionsTotal, 3)
})

test('lifecycle key prevents a recreated id from overwriting old usage', () => {
  const oldHeader = header('same-id', 10)
  const newHeader = header('same-id', 11)
  assert.notEqual(usageLedgerKey(oldHeader), usageLedgerKey(newHeader))
})
