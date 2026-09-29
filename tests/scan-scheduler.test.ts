import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapScanSessions } from '../src/host/scan-scheduler.ts'
import { apply } from '../src/host/index.ts'

test('cold scans use one worker and preserve every result', async () => {
  let active = 0
  let peak = 0
  const values = await mapScanSessions([1, 2, 3], async (n) => {
    peak = Math.max(peak, ++active)
    await new Promise<void>((resolve) => setImmediate(resolve))
    active--
    return n * 2
  })
  assert.equal(peak, 1)
  assert.deepEqual(values, [2, 4, 6])
})

test('cached rows yield to the event loop and cancellation stops new work', async () => {
  let cancelled = false
  const seen: number[] = []
  await assert.rejects(mapScanSessions([1, 2, 3], async (n) => {
    seen.push(n)
    setImmediate(() => { cancelled = true })
    return n
  }, () => cancelled), /cancelled/)
  assert.deepEqual(seen, [1])
})

test('host does not scan on startup or schedule idle scans; concurrent RPCs share work', async () => {
  let lists = 0
  let rpc: any
  let cleanup: any
  const ctx = {
    get(name: string) {
      if (name === 'sessionQuery') return { listSessions: async () => { lists++; return [] } }
      if (name === 'connection') return { rpc: { handle(_channel: string, handler: any) { rpc = handler; return () => {} } } }
    },
    on() {},
    interval() { assert.fail('no idle scan timer') },
    effect(factory: any) { cleanup = factory() },
  }
  apply(ctx as never)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(lists, 0)
  const [a, b] = await Promise.all([rpc('overview', {}), rpc('overview', {})])
  assert.equal(a.ok, true)
  assert.deepEqual(a, b)
  assert.equal(lists, 1)
  await rpc('overview', {})
  assert.equal(lists, 1)
  await rpc('overview', { force: true })
  assert.equal(lists, 2)
  await cleanup()
})
