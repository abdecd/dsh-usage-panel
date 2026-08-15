// dsh-usage-stats · Host face (web plugin entry)
// The first scan starts the moment the plugin loads (warm-up), so opening
// the settings page never waits for a cold scan. Reads are served from
// cache with stale-while-revalidate: a payload is fresh for 10 minutes;
// older ones return instantly with `stale: true` while a background
// rescan refreshes the cache, and a light periodic rescan keeps it warm.
// The refresh button forces a synchronous rescan. Day buckets cover the
// last half year (heatmap); the 30-day window feeds totals/byModel/bars;
// all-time data feeds cumulative KPIs and the model donut. Read-only.
export const name = 'dsh-usage-stats'
export const inject = ['timer', 'connection']

export function apply(ctx) {
  const sq = ctx.get('sessionQuery')
  const tag = '[dsh-usage-stats]'
  const STALE_MS = 10 * 60 * 1000   // cache freshness window
  const RESCAN_MS = 10 * 60 * 1000  // periodic keep-warm rescan
  const HEAT_DAYS = 182             // ~26 weeks for the contribution heatmap (recent half-year)
  const RECENT_DAYS = 30            // recent window for totals / model split / bars
  let cache = null
  let inflight = null
  let disposed = false

  function dayKey(ts) {
    const d = new Date(ts)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  function emptyTotals() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }

  function addUsage(target, usage) {
    const input = Number(usage && usage.inputTokens) || 0
    const output = Number(usage && usage.outputTokens) || 0
    const cacheRead = Number(usage && usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage && usage.cacheWriteTokens) || 0
    target.input += input
    target.output += output
    target.cacheRead += cacheRead
    target.cacheWrite += cacheWrite
    target.total += input + output + cacheRead + cacheWrite
  }

  function modelBucket(map, model) {
    return map[model] || (map[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
  }

  function sortedModels(map) {
    return Object.keys(map).map((model) => ({
      model,
      input: map[model].input,
      output: map[model].output,
      cacheRead: map[model].cacheRead,
      cacheWrite: map[model].cacheWrite,
      total: map[model].total,
    })).sort((a, b) => b.total - a.total)
  }

  function totalsFromModels(models) {
    const totals = emptyTotals()
    for (const item of models) {
      totals.input += item.input
      totals.output += item.output
      totals.cacheRead += item.cacheRead
      totals.cacheWrite += item.cacheWrite
      totals.total += item.total
    }
    return totals
  }

  function emptyOverview() {
    const days = []
    const now = new Date()
    for (let i = HEAT_DAYS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      days.push({ date: dayKey(d.getTime()), total: 0, models: {} })
    }
    return {
      days,
      totals: emptyTotals(),
      sessionCount: 0,
      byModel: [],
      allTime: { totals: emptyTotals(), sessionCount: 0, byModel: [] },
      updatedAt: Date.now(),
    }
  }

  async function scan() {
    if (!sq) {
      console.log(tag, 'sessionQuery unavailable; returning empty overview')
      return emptyOverview()
    }
    if (disposed) return emptyOverview()
    const recentCutoff = Date.now() - RECENT_DAYS * 24 * 3600 * 1000
    const dayStats = {}
    const recentSessions = {}
    const recentModelTotals = {}
    const allTimeSessions = {}
    const allTimeModelTotals = {}
    let sessions = []
    try {
      sessions = await sq.listSessions()
    } catch (err) {
      console.log(tag, 'listSessions failed:', String((err && err.message) || err))
      return emptyOverview()
    }

    for (const rec of sessions) {
      if (disposed) return emptyOverview()
      const header = rec && rec.header
      if (!header) continue
      const sessionId = String(header.id)
      const seedLength = Number(header.seedLength) || 0
      let snapshot = null
      try { snapshot = await sq.readSession(header.id) } catch (err) { continue }
      const events = snapshot && snapshot.events
      if (!events || !events.length) continue

      // Keep model context from seed events, but never count seed usage.
      let model = 'unknown'
      for (const event of events) {
        if (event.type === 'request/context') {
          if (event.data && event.data.model) model = event.data.model
          continue
        }
        if (event.type === 'request/header') {
          const config = event.data && event.data.header && event.data.header.config
          if (config && config.model) model = config.model
          continue
        }
        if (event.seq <= seedLength || event.type !== 'assistant/message') continue
        const usage = event.data && event.data.usage
        if (!usage) continue

        addUsage(modelBucket(allTimeModelTotals, model), usage)
        allTimeSessions[sessionId] = true
        if (event.time >= recentCutoff) {
          addUsage(modelBucket(recentModelTotals, model), usage)
          recentSessions[sessionId] = true
        }
        // Day buckets are not cutoff-gated: the heatmap window may reach
        // back half a year, and per-day maps stay tiny either way.
        const key = dayKey(event.time)
        const day = dayStats[key] || (dayStats[key] = { models: {} })
        addUsage(modelBucket(day.models, model), usage)
      }
    }

    const recentByModel = sortedModels(recentModelTotals)
    const allTimeByModel = sortedModels(allTimeModelTotals)
    const now = new Date()
    const days = []
    for (let i = HEAT_DAYS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = dayKey(d.getTime())
      const record = dayStats[key]
      const models = {}
      let total = 0
      if (record) {
        for (const model of Object.keys(record.models)) {
          const item = record.models[model]
          models[model] = { input: item.input, output: item.output, cacheRead: item.cacheRead, cacheWrite: item.cacheWrite, total: item.total }
          total += item.total
        }
      }
      days.push({ date: key, total, models })
    }

    return {
      days,
      totals: totalsFromModels(recentByModel),
      sessionCount: Object.keys(recentSessions).length,
      byModel: recentByModel,
      allTime: {
        totals: totalsFromModels(allTimeByModel),
        sessionCount: Object.keys(allTimeSessions).length,
        byModel: allTimeByModel,
      },
      updatedAt: Date.now(),
    }
  }

  function startScan() {
    if (disposed) return Promise.resolve(cache ? cache.payload : emptyOverview())
    if (inflight) return inflight
    const run = scan().then((payload) => {
      if (!disposed) cache = { at: Date.now(), payload }
      return payload
    })
    inflight = run
    run.catch(() => {}).then(() => { if (inflight === run) inflight = null })
    return run
  }

  function overview(args) {
    const force = !!(args && args.force)
    if (!force && cache) {
      if (Date.now() - cache.at < STALE_MS) return Promise.resolve(cache.payload)
      startScan() // stale-while-revalidate: background refresh
      return Promise.resolve(Object.assign({}, cache.payload, { stale: true }))
    }
    return startScan()
  }

  // RPC channel for the browser half: /usage-stats/overview.
  const disposeRpc = ctx.connection.rpc.handle('/usage-stats', (endpoint, payload) => {
    if (endpoint === 'overview') {
      return overview(payload).then(
        (value) => ({ ok: true, value }),
        (err) => ({ ok: false, error: { code: 'internal', message: String((err && err.message) || err), details: {} } })
      )
    }
    return Promise.resolve({ ok: false, error: { code: 'bad-request', message: 'unknown endpoint: ' + String(endpoint), details: { issues: [] } } })
  }, { authority: 'loopback' })

  // Warm up the moment the plugin loads: by the time the user opens the
  // settings page the overview is already cached and returns instantly.
  startScan()

  // Keep-warm: a light periodic rescan so the cached payload never goes
  // stale enough to force a synchronous wait on the next open.
  const stopTimer = ctx.interval(() => { if (!inflight) startScan() }, RESCAN_MS)

  ctx.effect(() => () => {
    disposed = true
    if (stopTimer) stopTimer()
    return disposeRpc()
  })
}
