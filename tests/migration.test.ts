import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { usagePanelProjectionDefinition } from '../src/host/projection-unit.ts'
import { listPersistenceRevisions } from '../src/host/index.ts'
import { scanFallback } from '../src/host/scan.ts'
import { usageLedgerKey } from '../src/host/history.ts'

function bill(session: Session, input: number, step: number) {
  session.append('assistant/chunk', { turn: 1, step, chunk: { type: 'usage', usage: { inputTokens: input } } } as never)
  session.append('step/end', { turn: 1, step } as never)
}

function fork() {
  const parent = Session.create(SessionId('usage-parent'))
  bill(parent, 100, 1)
  const child = Session.create(SessionId('usage-child'), parent.snapshotEvents(), {
    ...parent.header, id: SessionId('usage-child'), isSeeded: true, parentSession: parent.id,
  }, SessionLogOffset(parent.seq))
  bill(child, 7, 2)
  return child
}

test('rc.2 persistence list() revisions keep unchanged sessions on the ledger cache', async () => {
  const live = fork()
  let listCalls = 0
  const errors: string[] = []
  const revisions = await listPersistenceRevisions({
    list: async () => {
      listCalls += 1
      return [{ header: live.header, revision: 'file:1' }]
    },
  }, (message) => errors.push(message))
  assert.equal(listCalls, 1)
  assert.equal(revisions.get(usageLedgerKey(live.header)), 'file:1')
  assert.deepEqual(errors, [])
})

test('rc.1 live and restored snapshots exclude inherited usage and reread after appends', async () => {
  const live = fork()
  assert.equal('events' in live, false)
  const snapshot = live.snapshotEvents()
  const sq = {
    listSessions: async () => [{ header: live.header, live: true, persisted: true }],
    readSession: async () => ({ session: live.header, inheritedEventCount: live.inheritedEventCount, events: live.snapshotEvents() }),
  }
  const deps = { sq: sq as never, providerNames: {}, logFailure: (message: string) => assert.fail(message), liveSessionOf: () => live }
  assert.equal((await scanFallback(deps, Date.now())).allTime.totals.input, 7)
  bill(live, 3, 3)
  assert.notEqual(live.snapshotEvents(), snapshot)
  assert.equal((await scanFallback(deps, Date.now())).allTime.totals.input, 10)
  sq.listSessions = async () => [{ header: live.header, live: false, persisted: true }]
  assert.equal((await scanFallback(deps, Date.now())).allTime.totals.input, 10)
  const restored = Session.fromRestore(live.id, live.snapshotEvents(), live.header, live.inheritedEventCount, 'detached')
  assert.equal(restored.inheritedEventCount, live.inheritedEventCount)
  assert.ok(restored.firstLiveSeq > restored.inheritedEventCount)
})

test('rc.1 real projection registry accepts state/wire definition and removes it on fiber disposal', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(Object.assign((child: Context) => {
      child.sessionProjections.register(usagePanelProjectionDefinition)
    }, { inject: ['sessionProjections'] }))
    const live = fork()
    assert.equal(ctx.sessionProjections.snapshot(live).values.usagePanel?.totals.input, 7)
    await fiber.dispose()
    assert.equal(ctx.sessionProjections.snapshot(live).values.usagePanel, undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})
