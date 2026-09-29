import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  isSeededSessionConstructorError,
  readSessionLog,
  type SessionHandleLike,
  type SessionPersistenceLike,
} from '../src/host/session-read.ts'
import { scanFallback } from '../src/host/scan.ts'
import { foldEvents } from '../src/host/projection.ts'

test('isSeededSessionConstructorError identifies the upstream DSH bug message', () => {
  assert.equal(
    isSeededSessionConstructorError(new Error('seeded session constructor seed must equal its inherited prefix')),
    true,
  )
  assert.equal(
    isSeededSessionConstructorError('seeded session constructor seed must equal its inherited prefix'),
    true,
  )
  assert.equal(
    isSeededSessionConstructorError(new Error('session not found')),
    false,
  )
  assert.equal(
    isSeededSessionConstructorError(null),
    false,
  )
})

test('readSessionLog returns sq.readSession result when successful without calling persistence', async () => {
  const sessionId = SessionId('session-normal')
  const dummyHeader = { id: sessionId, isSeeded: false, createdAt: 1000 } as never
  const dummyEvents: readonly SessionEvent[] = []
  let persistenceCalled = false

  const sq = {
    readSession: async () => ({
      session: dummyHeader,
      inheritedEventCount: SessionLogOffset(0),
      events: dummyEvents,
    }),
  }

  const persistence: SessionPersistenceLike = {
    open: async () => {
      persistenceCalled = true
      throw new Error('should not be called')
    },
  }

  const result = await readSessionLog(sq as never, persistence, sessionId)
  assert.equal(result.session.id, sessionId)
  assert.equal(result.inheritedEventCount, 0)
  assert.equal(persistenceCalled, false)
})

test('readSessionLog falls back to persistence.open on seeded constructor error', async () => {
  const sessionId = SessionId('session-seeded')
  const seededHeader = { id: sessionId, isSeeded: true, createdAt: 2000 } as never
  const dummyEvents = [
    { seq: 0, type: 'session/end-seed', data: { inherited: true } },
    { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 42 } } } },
  ] as unknown as readonly SessionEvent[]

  let handleClosed = false
  const sq = {
    readSession: async () => {
      throw new Error('seeded session constructor seed must equal its inherited prefix')
    },
  }

  const persistence: SessionPersistenceLike = {
    open: async (id, access) => {
      assert.equal(id, sessionId)
      assert.equal(access, 'read')
      const handle: SessionHandleLike = {
        header: seededHeader,
        inheritedEventCount: 1,
        read: async (fromSeq) => {
          assert.equal(fromSeq, 0)
          return { events: dummyEvents }
        },
        close: async () => {
          handleClosed = true
        },
      }
      return handle
    },
  }

  const result = await readSessionLog(sq as never, persistence, sessionId)
  assert.equal(result.session.id, sessionId)
  assert.equal(result.inheritedEventCount, 1)
  assert.equal(result.events.length, 2)
  assert.equal(handleClosed, true)
})

test('readSessionLog rethrows original error when error is not seeded constructor error', async () => {
  const sessionId = SessionId('session-404')
  let persistenceCalled = false
  const sq = {
    readSession: async () => {
      throw new Error('SESSION_NOT_FOUND')
    },
  }
  const persistence: SessionPersistenceLike = {
    open: async () => {
      persistenceCalled = true
      throw new Error('should not be called')
    },
  }

  await assert.rejects(
    async () => {
      await readSessionLog(sq as never, persistence, sessionId)
    },
    { message: 'SESSION_NOT_FOUND' },
  )
  assert.equal(persistenceCalled, false)
})

test('scanFallback reads cold persistence directly and preserves fork usage', async () => {
  const parent = Session.create(SessionId('parent-session'))
  parent.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100 } } } as never)
  parent.append('step/end', { turn: 1, step: 1 } as never)

  const childId = SessionId('child-seeded-session')
  const childHeader = { ...parent.header, id: childId, isSeeded: true, parentSession: parent.id }
  const childEvents = [
    ...parent.snapshotEvents(),
    { seq: parent.seq, type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 55 } } } },
    { seq: parent.seq + 1, type: 'step/end', data: { turn: 1, step: 2 } },
  ] as unknown as readonly SessionEvent[]

  const sq = {
    listSessions: async () => [{ header: childHeader, live: false, persisted: true }],
    readSession: async () => {
      assert.fail('cold scan must not invoke expensive query replay')
    },
  }

  let handleClosed = false
  const persistence: SessionPersistenceLike = {
    open: async (id) => {
      assert.equal(id, childId)
      return {
        header: childHeader,
        inheritedEventCount: parent.seq,
        read: async () => ({ events: childEvents }),
        close: async () => {
          handleClosed = true
        },
      }
    },
  }

  const failures: string[] = []
  const overview = await scanFallback({
    sq: sq as never,
    persistence,
    providerNames: {},
    logFailure: (msg) => failures.push(msg),
  }, Date.now())

  assert.equal(overview.coverage.sessionsTotal, 1)
  assert.equal(overview.coverage.sessionsOk, 1)
  assert.equal(overview.coverage.sessionsFailed, 0)
  assert.equal(failures.length, 0)
  assert.equal(handleClosed, true)
  assert.equal(overview.allTime.totals.input, 55)
})

for (const chunkOnly of [false, true]) {
  test(`cold persistence repairs interrupted ${chunkOnly ? 'chunk' : 'message'} usage without changing source`, async () => {
    const session = Session.create(SessionId('interrupted'))
    session.append('turn/start', { turn: 1 } as never)
    session.append('step/start', { turn: 1, step: 1 } as never)
    if (chunkOnly) {
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 42 } } } as never)
    }
    const events = chunkOnly ? session.snapshotEvents() : [
      ...session.snapshotEvents(),
      { type: 'assistant/message', seq: session.seq, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 42 } } } as unknown as SessionEvent,
    ]
    const size = events.length
    let closed = false
    const snapshot = await readSessionLog({ readSession: async () => { assert.fail('query replay') } } as never, {
      open: async () => ({
        header: session.header, inheritedEventCount: 0,
        read: async () => ({ events }), close: async () => { closed = true },
      }),
    }, session.id, true)
    assert.equal(foldEvents(snapshot.events, 0).totals.input, 42)
    assert.equal(events.length, size)
    assert.equal(closed, true)
  })
}
