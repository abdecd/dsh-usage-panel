// dsh-usage-panel · Client bundle (web plugin `./client` export)
// Registers a "消耗统计" settings page (settings.section) showing:
// cumulative KPIs (all-time) · activity heatmap (PALETTE-blue ramp,
// theme-aware) · stacked daily bar chart (default 7 days, per-model
// colors, hover tooltip with per-model breakdown) · model donut + top-5
// list (+其他, hover tooltip with token share). Data arrives over the
// package's own RPC channel /usage-stats.
window.__ModuleLoader__.load({
  id: 'dsh-usage-panel',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var PALETTE = ['#4f8cff', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#14b8a6']
    var STYLE_ID = 'dsh-usage-panel/styles'

    function fmtTokens(n) {
      n = Math.round(n || 0)
      if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿'
      if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万'
      return String(n)
    }

    function fmtCompact(n) {
      n = Math.round(n || 0)
      if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
      if (n >= 1e4) return (n / 1e4).toFixed(0) + '万'
      return String(n)
    }

    function pctOf(v, total) {
      if (!total) return '0.0'
      return ((v / total) * 100).toFixed(1)
    }

    function niceCeil(v) {
      if (!(v > 0)) return 1
      const p = Math.pow(10, Math.floor(Math.log10(v)))
      const d = v / p
      const m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10
      return m * p
    }

    function dateLabel(key) {
      const p = key.split('-')
      return p[1] + '/' + p[2]
    }

    function dateCN(key) {
      const p = key.split('-')
      return Number(p[1]) + '月' + Number(p[2]) + '日'
    }

    // Parse a local YYYY-MM-DD key at local midnight (never via new Date(string),
    // which would shift the day in non-UTC timezones).
    function parseDayKey(key) {
      const p = key.split('-')
      return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
    }

    function keyOfDate(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    // Monday-first weekday index 0..6.
    function weekdayIndex(key) {
      return (parseDayKey(key).getDay() + 6) % 7
    }

    // Count-up hook (easeOutCubic) driving the KPI number entrance.
    function useCountUp(target, duration) {
      const [value, setValue] = React.useState(0)
      React.useEffect(() => {
        const start = performance.now()
        let raf
        const tick = (now) => {
          const t = Math.min(1, (now - start) / duration)
          const eased = 1 - Math.pow(1 - t, 3)
          setValue(target * eased)
          if (t < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => { if (raf) cancelAnimationFrame(raf) }
      }, [target, duration])
      return value
    }

    // Top-5 models with stable colors + a merged "其他" row for the rest.
    function modelRows(byModel) {
      const rows = []
      for (let i = 0; i < byModel.length && i < 5; i++) {
        rows.push({ model: byModel[i].model, total: byModel[i].total, color: PALETTE[i % PALETTE.length], rest: false })
      }
      if (byModel.length > 5) {
        rows.push({ model: '其他', total: byModel.slice(5).reduce((s, m) => s + m.total, 0), color: null, rest: true })
      }
      return rows
    }

    function callOverview(rpc, force) {
      return rpc.call('/usage-stats', 'overview', { force: !!force }).then((res) => {
        if (res && res.ok) return res.value
        const message = res && res.error ? res.error.message : '未知错误'
        throw new Error(message)
      })
    }

    function StatsSection(props) {
      const rpc = props.rpc
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [range, setRange] = React.useState(7)
      const [barTip, setBarTip] = React.useState(null)
      const [donutTip, setDonutTip] = React.useState(null)
      const [heatTip, setHeatTip] = React.useState(null)

      const load = React.useCallback((force) => {
        setLoading(true)
        setError(null)
        callOverview(rpc, force)
          .then((res) => setData(res))
          .catch((err) => setError(String((err && err.message) || err)))
          .then(() => setLoading(false))
      }, [rpc])

      React.useEffect(() => { load(false) }, [load])

      const allTime = (data && data.allTime) || { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, sessionCount: 0, byModel: [] }
      const allTimeTotals = allTime.totals || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      const allTimeTotal = allTimeTotals.total || 0
      const allTimeTop = allTime.byModel[0] || null
      const allTimeInputTotal = allTimeTotals.input + allTimeTotals.cacheRead + allTimeTotals.cacheWrite

      const recentByModel = (data && data.byModel) || []
      const days = (data && data.days) || []

      // KPI entrance count-up (900ms, easeOutCubic). These hook calls must
      // stay unconditional: the kpis branch below renders conditionally, and
      // conditionally-called hooks would break React's hook-order invariant.
      // allTime* fall back to 0 before data arrives, so the animation plays
      // 0 → target exactly when the numbers first show up.
      const animatedTotal = useCountUp(allTimeTotal, 900)
      const animatedInputTotal = useCountUp(allTimeInputTotal, 900)
      const animatedOutput = useCountUp(allTimeTotals.output, 900)
      const animatedSessions = useCountUp(allTime.sessionCount, 900)

      // Header subtitle: loading → live update time (+后台更新中 on stale hits).
      let subText = null
      if (!data && !error) subText = '正在统计会话日志…'
      else if (data) {
        subText = '数据更新于 ' + new Date(data.updatedAt || Date.now()).toLocaleTimeString()
        if (data.stale) subText += ' · 后台更新中…'
      }

      // ---------- body ----------
      let body = null
      if (!data && !error) {
        body = React.createElement('div', { className: 'dsw-ust-empty' },
          React.createElement('div', { className: 'dsw-ust-empty-title' }, '正在统计会话日志…'),
          React.createElement('div', null, '插件加载时已开始预热，通常只需等待片刻')
        )
      } else if (error) {
        body = React.createElement('div', { className: 'dsw-ust-empty' }, '加载失败：' + error)
      } else if (allTimeTotal === 0) {
        body = React.createElement('div', { className: 'dsw-ust-empty' },
          React.createElement('div', { className: 'dsw-ust-empty-title' }, '暂无统计数据'),
          React.createElement('div', null, '开始使用 DeepSeek Harness 后，这里会展示 Token 消耗情况')
        )
      } else {
        // --- KPI cards (all-time) ---
        const kpis = React.createElement('div', { className: 'dsw-ust-kpis' },
          React.createElement('div', { className: 'dsw-ust-kpi' },
            React.createElement('div', { className: 'l' }, 'Token 总用量'),
            React.createElement('div', { className: 'v' }, fmtTokens(animatedTotal)),
            React.createElement('div', { className: 'd' }, '输入 ' + fmtTokens(animatedInputTotal) + ' · 输出 ' + fmtTokens(animatedOutput))
          ),
          React.createElement('div', { className: 'dsw-ust-kpi' },
            React.createElement('div', { className: 'l' }, '总会话数量'),
            React.createElement('div', { className: 'v' }, String(Math.round(animatedSessions)))
          ),
          React.createElement('div', { className: 'dsw-ust-kpi' },
            React.createElement('div', { className: 'l' }, '最常用模型'),
            React.createElement('div', { className: 'v v-sm' }, allTimeTop ? allTimeTop.model : '—'),
            React.createElement('div', { className: 'd' }, allTimeTop ? '占比 ' + pctOf(allTimeTop.total, allTimeTotal) + '%' : '')
          )
        )

        // --- heatmap: contribution graph, columns = weeks, rows = weekdays ---
        // Quartile thresholds over non-zero days keep the ramp informative
        // even when one outlier day dwarfs the rest.
        const byDate = {}
        const nonzero = []
        for (const d of days) {
          byDate[d.date] = d
          if (d.total > 0) nonzero.push(d.total)
        }
        nonzero.sort((a, b) => a - b)
        const q = (p) => (nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(p * (nonzero.length - 1)))] : Infinity)
        const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75)
        const levelOf = (total) => {
          if (total <= 0) return 0
          return total <= q1 ? 1 : total <= q2 ? 2 : total <= q3 ? 3 : 4
        }

        const firstDay = parseDayKey(days[0].date)
        const lead = weekdayIndex(days[0].date) // blank cells before day 0
        // Enough columns for the leading padding + every in-window day.
        const heatWeeks = Math.ceil((lead + days.length) / 7)
        const monthLabels = []
        const gridCells = []
        let prevMonth = -1
        for (let w = 0; w < heatWeeks; w++) {
          const monday = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - lead + w * 7)
          const m = monday.getMonth()
          monthLabels.push(w === 0 || m !== prevMonth ? String(m + 1) + '月' : '')
          prevMonth = m
          for (let r = 0; r < 7; r++) {
            const cur = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + r)
            const key = keyOfDate(cur)
            const rec = byDate[key]
            if (!rec) {
              // Outside the window (before day 0 or in the future): placeholder.
              gridCells.push(React.createElement('div', { key: key + '-blank', className: 'dsw-ust-heat-cell dsw-ust-heat-blank' }))
              continue
            }
            const level = levelOf(rec.total)
            gridCells.push(React.createElement('div', {
              key,
              className: 'dsw-ust-heat-cell dsw-ust-h' + level,
              onMouseEnter: (e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setHeatTip({ left: rect.left + rect.width / 2, top: rect.top - 6, title: dateCN(key) + ' · ' + fmtTokens(rec.total) + ' Tokens', lines: [] })
              },
              onMouseLeave: () => setHeatTip(null),
            }))
          }
        }
        const heatCard = React.createElement('div', { className: 'dsw-ust-card' },
          React.createElement('div', { className: 'dsw-ust-card-head' },
            React.createElement('div', { className: 'dsw-ust-card-title' },
              React.createElement('h3', null, '活跃热力图'),
              React.createElement('span', { className: 'dsw-ust-card-sub' }, '最近半年')
            ),
            React.createElement('div', { className: 'dsw-ust-heat-legend' },
              React.createElement('span', null, '少'),
              [1, 2, 3, 4].map((l) => React.createElement('i', { key: l, className: 'dsw-ust-heat-swatch dsw-ust-h' + l })),
              React.createElement('span', null, '多')
            )
          ),
          React.createElement('div', { className: 'dsw-ust-heat-wrap' },
            React.createElement('div', { className: 'dsw-ust-heat-weekdays' },
              ['一', '', '三', '', '五', '', ''].map((t, i) => React.createElement('span', { key: i }, t))
            ),
            React.createElement('div', { className: 'dsw-ust-heat-main' },
              React.createElement('div', { className: 'dsw-ust-heat-months', style: { gridTemplateColumns: 'repeat(' + heatWeeks + ', minmax(12px, 1fr))', minWidth: (heatWeeks * 12 + (heatWeeks - 1) * 3) + 'px' } },
                monthLabels.map((m, i) => React.createElement('span', { key: i, className: 'dsw-ust-heat-month' }, m))
              ),
              React.createElement('div', { className: 'dsw-ust-heat', style: { gridTemplateColumns: 'repeat(' + heatWeeks + ', minmax(12px, 1fr))', minWidth: (heatWeeks * 12 + (heatWeeks - 1) * 3) + 'px' } }, gridCells)
            )
          )
        )

        // --- stacked bar chart (recent window) ---
        const rows = modelRows(recentByModel)
        const topNames = {}
        for (let i = 0; i < recentByModel.length && i < 5; i++) topNames[recentByModel[i].model] = true
        const othersOf = (d) => {
          let s = 0
          const names = Object.keys(d.models)
          for (let i = 0; i < names.length; i++) if (!topNames[names[i]]) s += d.models[names[i]].total
          return s
        }
        const rangeDays = days.slice(-range)
        const yMax = niceCeil(Math.max.apply(null, rangeDays.map((d) => d.total).concat(1)))
        const W = 720, H = 230, PL = 52, PR = 12, PT = 10, PB = 26
        const plotW = W - PL - PR
        const plotH = H - PT - PB
        const n = rangeDays.length
        const band = plotW / n
        const barW = Math.min(44, band * 0.6)
        const yLines = []
        for (let i = 0; i <= 4; i++) {
          const v = (yMax / 4) * i
          const y = PT + plotH - (v / yMax) * plotH
          yLines.push(React.createElement('g', { key: 'y' + i },
            React.createElement('line', { x1: PL, x2: W - PR, y1: y, y2: y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, strokeDasharray: i === 0 ? 'none' : '3 3' }),
            React.createElement('text', { x: PL - 6, y: y + 3, textAnchor: 'end', className: 'dsw-ust-axis' }, fmtCompact(v))
          ))
        }
        const bars = rangeDays.map((d, i) => {
          const x = PL + band * i + (band - barW) / 2
          const segs = []
          let acc = 0
          for (let j = 0; j < rows.length; j++) {
            const r = rows[j]
            const v = r.rest ? othersOf(d) : (d.models[r.model] ? d.models[r.model].total : 0)
            if (v > 0) {
              const h = (v / yMax) * plotH
              segs.push(React.createElement('rect', {
                key: r.model, x, y: PT + plotH - acc - h, width: barW, height: h,
                fill: r.rest ? 'var(--dsw-alias-label-secondary)' : r.color, opacity: r.rest ? 0.45 : 1, rx: 2,
                className: 'dsw-ust-bar-seg',
                style: { animationDelay: (i * 30) + 'ms' },
              }))
              acc += h
            }
          }
          if (acc === 0) segs.push(React.createElement('rect', {
            key: 'zero', x, y: PT + plotH - 2, width: barW, height: 2, fill: 'var(--dsw-alias-border-l2)',
            className: 'dsw-ust-bar-seg',
            style: { animationDelay: (i * 30) + 'ms' },
          }))
          return React.createElement('g', {
            key: d.date,
            className: 'dsw-ust-bar-day',
            onMouseEnter: (e) => {
              const lines = []
              let acc = 0
              for (const r of rows) {
                const v = r.rest ? othersOf(d) : (d.models[r.model] ? d.models[r.model].total : 0)
                if (v > 0) {
                  lines.push({ label: r.model, value: fmtTokens(v) + ' Tokens', color: r.rest ? 'var(--dsw-alias-label-secondary)' : r.color })
                  acc += v
                }
              }
              const rect = e.currentTarget.getBoundingClientRect()
              setBarTip({
                left: rect.left + rect.width / 2,
                top: rect.top - 6,
                title: dateCN(d.date) + ' · 共 ' + fmtTokens(d.total || acc) + ' Tokens',
                lines,
              })
            },
            onMouseLeave: () => setBarTip(null),
          }, segs)
        })
        const xStep = n <= 7 ? 1 : Math.ceil(n / 7)
        const xLabels = rangeDays.map((d, i) => (i % xStep === 0 || i === n - 1)
          ? React.createElement('text', { key: d.date, x: PL + band * i + band / 2, y: H - 8, textAnchor: 'middle', className: 'dsw-ust-axis' }, dateLabel(d.date))
          : null)
        const legend = React.createElement('div', { className: 'dsw-ust-legend' },
          rows.map((r) => React.createElement('span', { key: r.model, className: 'dsw-ust-legend-item' },
            React.createElement('i', { style: { background: r.rest ? 'var(--dsw-alias-label-secondary)' : r.color, opacity: r.rest ? 0.45 : 1 } }),
            r.model
          )))
        const barCard = React.createElement('div', { className: 'dsw-ust-card' },
          React.createElement('div', { className: 'dsw-ust-card-head' },
            React.createElement('div', { className: 'dsw-ust-card-title' },
              React.createElement('h3', null, '每日 Token 用量'),
              React.createElement('span', { className: 'dsw-ust-card-sub' }, '按模型堆叠')
            ),
            React.createElement('div', { className: 'dsw-ust-range' },
              [7, 14, 30].map((r) => React.createElement('button', { key: r, className: range === r ? 'on' : '', onClick: () => setRange(r) }, r + '天'))
            )
          ),
          React.createElement('svg', { viewBox: '0 0 720 230', className: 'dsw-ust-chart', preserveAspectRatio: 'xMidYMid meet' }, yLines, bars, xLabels),
          legend
        )

        // --- donut + top-5 list (all-time) ---
        const allRows = modelRows(allTime.byModel)
        const R = 70
        const C = 2 * Math.PI * R
        const segs = []
        let acc = 0
        for (let i = 0; i < allRows.length; i++) {
          const r = allRows[i]
          const frac = allTimeTotal ? r.total / allTimeTotal : 0
          if (frac <= 0) continue
          const len = frac * C
          segs.push(React.createElement('circle', {
            key: r.model, cx: 90, cy: 90, r: R, fill: 'none', className: 'dsw-ust-donut-seg',
            stroke: r.rest ? 'var(--dsw-alias-label-secondary)' : r.color,
            strokeOpacity: r.rest ? 0.45 : 1, strokeWidth: 24,
            strokeDasharray: len + ' ' + (C - len), strokeDashoffset: -acc,
            // No transform attribute: the dsw-ust-donut-spin keyframes own
            // rotation (-90deg → 270deg) and a CSS transform would be
            // overridden by it anyway.
            onMouseEnter: (e) => {
              // Anchor at the pointer: a circle's bbox spans the whole donut,
              // so rect-based anchoring would pin every segment to one spot.
              setDonutTip({
                left: e.clientX,
                top: e.clientY - 6,
                title: r.model,
                lines: [
                  { label: 'Tokens', value: fmtTokens(r.total) },
                  { label: '占比', value: pctOf(r.total, allTimeTotal) + '%', color: r.rest ? 'var(--dsw-alias-label-secondary)' : r.color },
                ],
              })
            },
            onMouseLeave: () => setDonutTip(null),
          }))
          acc += len
        }
        const donut = React.createElement('div', { className: 'dsw-ust-donut' },
          React.createElement('svg', { width: 180, height: 180, viewBox: '0 0 180 180' },
            React.createElement('circle', { cx: 90, cy: 90, r: R, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2)', strokeWidth: 24 }),
            segs,
            React.createElement('text', { x: 90, y: 86, textAnchor: 'middle', className: 'dsw-ust-donut-total' }, fmtTokens(allTimeTotal)),
            React.createElement('text', { x: 90, y: 106, textAnchor: 'middle', className: 'dsw-ust-donut-cap' }, 'Token 总用量')
          )
        )
        const listRows = allRows.map((r) =>
          React.createElement('div', { key: r.model, className: 'dsw-ust-mrow' },
            React.createElement('i', { className: 'dsw-ust-dot', style: { background: r.rest ? 'var(--dsw-alias-label-secondary)' : r.color, opacity: r.rest ? 0.45 : 1 } }),
            React.createElement('span', { className: 'dsw-ust-mname', title: r.model }, r.model),
            React.createElement('span', { className: 'dsw-ust-mtokens' }, fmtTokens(r.total)),
            React.createElement('span', { className: 'dsw-ust-mpct' }, pctOf(r.total, allTimeTotal) + '%')
          ))
        const modelCard = React.createElement('div', { className: 'dsw-ust-card' },
          React.createElement('h3', null, '模型用量'),
          React.createElement('div', { className: 'dsw-ust-models' },
            donut,
            React.createElement('div', { className: 'dsw-ust-mlist' }, listRows)
          )
        )

        body = [kpis, heatCard, barCard, modelCard]
      }

      // Shared hover-tooltip renderer (bar chart + donut): fixed-position
      // popup with a bold title and color-dotted detail rows, shown with no
      // native <title> delay.
      const renderTip = (tip) => tip
        ? React.createElement('div', { className: 'dsw-ust-tooltip show', style: { left: tip.left, top: tip.top } },
            React.createElement('div', { className: 'dsw-ust-tooltip-title' }, tip.title),
            tip.lines.map((l, idx) => React.createElement('div', { key: idx, className: 'dsw-ust-tooltip-row' },
              React.createElement('i', { style: { background: l.color || 'var(--dsw-alias-label-secondary)' } }),
              React.createElement('span', { className: 'dsw-ust-tooltip-label' }, l.label),
              React.createElement('span', { className: 'dsw-ust-tooltip-value' }, l.value)
            )))
        : null

      return React.createElement('div', { className: 'dsw-ust-root' },
        renderTip(barTip),
        renderTip(donutTip),
        renderTip(heatTip),
        React.createElement('div', { className: 'dsw-ust-head' },
          React.createElement('div', null,
            React.createElement('h2', null, '消耗统计'),
            subText ? React.createElement('div', { className: 'dsw-ust-sub' }, subText) : null
          ),
          React.createElement('button', { className: 'dsw-ust-refresh', onClick: () => load(true), disabled: loading, title: '重新拉取最新统计' },
            React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
              React.createElement('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
              React.createElement('polyline', { points: '21 3 21 9 15 9' })
            ),
            loading ? '刷新中…' : '刷新'
          )
        ),
        body
      )
    }

    var CSS = [
      '.dsw-ust-root{position:relative;display:flex;flex-direction:column;gap:14px;padding:18px 20px 28px;min-width:0}',
      '.dsw-ust-tooltip{position:fixed;left:0;top:0;transform:translate(-50%,-110%);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);padding:5px 10px;border-radius:6px;font-size:11px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.06);opacity:0;transition:opacity .1s;z-index:9999}',
      '.dsw-ust-tooltip.show{opacity:1}',
      '.dsw-ust-tooltip-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px;white-space:nowrap}',
      '.dsw-ust-tooltip-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;line-height:1.6}',
      '.dsw-ust-tooltip-row i{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}',
      '.dsw-ust-tooltip-row .dsw-ust-tooltip-label{flex:1;color:var(--dsw-alias-label-primary)}',
      '.dsw-ust-tooltip-row .dsw-ust-tooltip-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsw-ust-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dsw-ust-head h2{margin:0;font-size:16px;font-weight:650;color:var(--dsw-alias-label-primary)}',
      '.dsw-ust-sub{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-ust-refresh{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 11px;font-size:12px;cursor:pointer;flex-shrink:0}',
      '.dsw-ust-refresh:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsw-ust-refresh:disabled{opacity:.55;cursor:default}',
      '.dsw-ust-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;min-width:0}',
      '.dsw-ust-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}',
      '.dsw-ust-card h3{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsw-ust-card-head h3{margin:0}',
      '.dsw-ust-card-title{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.dsw-ust-card-sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
      '.dsw-ust-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.dsw-ust-kpi{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:13px 15px;min-width:0}',
      '.dsw-ust-kpi .l{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-ust-kpi .v{margin-top:7px;font-size:19px;font-weight:700;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;line-height:1.2;word-break:break-all}',
      '.dsw-ust-kpi .v-sm{font-size:15px}',
      '.dsw-ust-kpi .d{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-ust-range{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;flex-shrink:0}',
      '.dsw-ust-range button{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:5px 11px;cursor:pointer}',
      '.dsw-ust-range button:hover{color:var(--dsw-alias-label-primary)}',
      '.dsw-ust-range button.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsw-ust-chart{width:100%;height:auto;display:block}',
      '.dsw-ust-axis{fill:var(--dsw-alias-label-secondary);font-size:10px;font-family:inherit}',
      '.dsw-ust-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px}',
      '.dsw-ust-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-ust-legend-item i{width:9px;height:9px;border-radius:3px;display:inline-block}',
      '.dsw-ust-models{display:flex;gap:18px;align-items:center;flex-wrap:wrap}',
      '.dsw-ust-donut{flex-shrink:0}',
      '.dsw-ust-donut-seg{cursor:pointer;transition:stroke-width .15s}',
      '.dsw-ust-donut-seg:hover{stroke-width:28px}',
      '.dsw-ust-donut-total{fill:var(--dsw-alias-label-primary);font-size:17px;font-weight:700;font-family:inherit}',
      '.dsw-ust-donut-cap{fill:var(--dsw-alias-label-secondary);font-size:10px;font-family:inherit}',
      '.dsw-ust-mlist{flex:1 1 190px;min-width:170px}',
      '.dsw-ust-mrow{display:flex;align-items:center;gap:9px;padding:6px 2px;font-size:12px;min-width:0}',
      '.dsw-ust-mrow+.dsw-ust-mrow{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsw-ust-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}',
      '.dsw-ust-mname{flex:1;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dsw-ust-mtokens{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsw-ust-mpct{width:52px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsw-ust-empty{background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:34px 20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.8}',
      '.dsw-ust-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}',
      '.dsw-ust-heat-wrap{position:relative;display:flex;gap:0;align-items:flex-start;overflow-x:auto;padding-bottom:2px;scrollbar-width:none;-ms-overflow-style:none}',
      '.dsw-ust-heat-wrap::-webkit-scrollbar{display:none}',
      '.dsw-ust-heat-weekdays{position:absolute;left:0;top:17px;bottom:2px;display:grid;grid-template-rows:repeat(7,1fr);gap:3px;width:10px;font-size:10px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.dsw-ust-heat-weekdays span{display:flex;align-items:center;align-self:center;height:12px;line-height:12px}',
      '.dsw-ust-heat-main{min-width:0;flex:1 1 auto;margin-left:18px}',
      '.dsw-ust-heat-months{display:grid;gap:3px;width:100%;height:14px;margin-bottom:3px;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-ust-heat-month{white-space:nowrap;min-width:0}',
      '.dsw-ust-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,auto);width:100%;min-width:max-content;gap:3px}',
      '.dsw-ust-heat-cell{aspect-ratio:1/1;border-radius:2px;cursor:default}',
      '.dsw-ust-heat-cell:hover{box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}',
      '.dsw-ust-heat-blank{background:transparent;cursor:default}',
      '.dsw-ust-h0{background:#eef2f7}',
      '.dsw-ust-h1{background:#dbeafe}',
      '.dsw-ust-h2{background:#93c5fd}',
      '.dsw-ust-h3{background:#3b82f6}',
      '.dsw-ust-h4{background:#1d4ed8}',
      'body[data-ds-dark-theme] .dsw-ust-h0{background:#1f2937}',
      'body[data-ds-dark-theme] .dsw-ust-h1{background:#1e3a8a}',
      'body[data-ds-dark-theme] .dsw-ust-h2{background:#2563eb}',
      'body[data-ds-dark-theme] .dsw-ust-h3{background:#3b82f6}',
      'body[data-ds-dark-theme] .dsw-ust-h4{background:#60a5fa}',
      '.dsw-ust-heat-legend{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0}',
      '.dsw-ust-heat-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}',
      '.dsw-ust-bar-seg{transform-origin:bottom;transform-box:fill-box;animation:dsw-ust-bar-grow .9s cubic-bezier(.16,1,.3,1) both}',
      '.dsw-ust-donut-seg{transform-box:fill-box;transform-origin:center;animation:dsw-ust-donut-spin .9s cubic-bezier(.16,1,.3,1) both}',
      '@keyframes dsw-ust-bar-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}',
      '@keyframes dsw-ust-donut-spin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}'
    ].join('\n')

    function apply(ctx) {
      // Own stylesheet, removed with this fiber.
      let tag = null
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-usage-panel'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      ctx.effect(() => () => {
        if (tag !== null && tag.isConnected) tag.remove()
      })

      const slots = ctx.slots
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'usage-stats', order: 25, label: '消耗统计' },
        () => React.createElement(StatsSection, { rpc: ctx.connection.rpc })
      ))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection']
    return module.exports
  }
})
