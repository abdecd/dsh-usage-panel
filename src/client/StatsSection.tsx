// dsh-usage-panel · settings-page orchestrator.
// State machine: loading / fresh / stale (background refresh) / fallback
// (refresh failed, cached payload kept with last success timestamp) / error.
// localStorage SWR cache makes a refresh render instantly (P1-⑨); the header
// keeps the v0.1.0 refresh button and gains the export menu (P1-⑧).
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Overview, ProviderItem } from '../shared/contract.ts'
import { formatClock } from '../shared/format.ts'
import { RECENT_DAYS, WEEK_DAYS, windowFromDays, type RangeSummary } from '../shared/usage.ts'
import { callOverview, loadCached, saveCached } from './api.ts'
import type { RpcLike } from './ctx.ts'
import type { I18n } from './locales.ts'
import { useI18n, useLatest, type Tip } from './hooks.ts'
import { Tooltip } from './components/Tooltip.tsx'
import { KpiCards } from './components/KpiCards.tsx'
import { Heatmap } from './components/Heatmap.tsx'
import { BarChart } from './components/BarChart.tsx'
import { SessionsCard } from './components/SessionsCard.tsx'
import { ProvidersCard } from './components/ProvidersCard.tsx'
import { ModelDonut } from './components/ModelDonut.tsx'
import { ExportMenu } from './components/ExportMenu.tsx'
import * as React from 'react'

export type Freshness = 'loading' | 'fresh' | 'stale' | 'fallback' | 'error'

/** The global range window that drives the KPI / bar-chart / donut summaries. */
export type RangeKey = '7d' | '30d' | 'all'

const RANGE_DEFAULT: RangeKey = '30d'

/** Day count for a range (Infinity = the full heatmap window). */
function rangeDayCount(range: RangeKey): number {
  return range === '7d' ? WEEK_DAYS : range === '30d' ? RECENT_DAYS : Number.POSITIVE_INFINITY
}

/** Roll a full Overview down to one range window (totals, models, sessions). */
function summarizeRange(data: Overview, range: RangeKey): RangeSummary {
  if (range === 'all') {
    return {
      totals: data.allTime.totals,
      byModel: data.allTime.byModel,
      sessionCount: data.allTime.sessionCount,
    }
  }
  const n = range === '7d' ? WEEK_DAYS : RECENT_DAYS
  const w = windowFromDays(data.days, n)
  const sessionCount =
    range === '7d' ? (typeof data.weekSessionCount === 'number' ? data.weekSessionCount : data.sessionCount) : data.sessionCount
  return { totals: w.totals, byModel: w.byModel, sessionCount }
}

/** Provider routes for one range window (the range drives the 服务商 card). */
function providersFor(data: Overview, range: RangeKey): ProviderItem[] {
  if (range === '7d') return data.week.providers
  if (range === 'all') return data.allTime.providers
  return data.providers
}

/** The per-day records a range window covers (the bar chart's input). */
function rangeDays(data: Overview, range: RangeKey): Overview['days'] {
  const n = rangeDayCount(range)
  return Number.isFinite(n) ? data.days.slice(-n) : data.days
}

interface StatsSectionProps {
  rpc: RpcLike
  i18n: I18n
}

export function StatsSection({ rpc, i18n: baseI18n }: StatsSectionProps): JSX.Element {
  const i18n = useI18n(baseI18n)
  const t = i18n.t
  const locale = i18n.locale

  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [freshness, setFreshness] = useState<Freshness>('loading')
  const [barTip, setBarTip] = useState<Tip | null>(null)
  const [donutTip, setDonutTip] = useState<Tip | null>(null)
  const [heatTip, setHeatTip] = useState<Tip | null>(null)
  const [range, setRange] = useState<RangeKey>(RANGE_DEFAULT)
  const dataRef = useLatest(data)

  const load = useCallback(
    (force: boolean) => {
      setLoading(true)
      setError(null)
      callOverview(rpc, force)
        .then((res) => {
          setData(res)
          setFreshness(res.stale ? 'stale' : 'fresh')
          saveCached(res)
        })
        .catch((err) => {
          const msg = String((err as Error)?.message ?? err)
          setError(msg)
          // Keep the last successful payload visible; never fake freshness.
          setFreshness(dataRef.current ? 'fallback' : 'error')
        })
        .then(() => setLoading(false))
    },
    [rpc],
  )

  useEffect(() => {
    const cached = loadCached()
    if (cached) {
      setData(cached.payload)
      setFreshness('fresh')
    }
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const allTime = (data && data.allTime) || { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, sessionCount: 0, byModel: [] }
  const allTimeTotal = allTime.totals.total || 0
  const days = (data && data.days) || []
  // The range window the summary cards reflect (7d / 30d / all); the heatmap
  // stays the fixed half-year view, and sessions / providers keep all-time.
  const summary = useMemo(() => (data ? summarizeRange(data, range) : null), [data, range])
  const barDays = useMemo(() => (data ? rangeDays(data, range) : []), [data, range])

  // Header subtitle: loading → update time (+ states).
  let subText: string | null = null
  if (!data && !error) subText = t('status.loading')
  else if (data) {
    const time = formatClock(data.updatedAt || Date.now(), locale)
    if (freshness === 'stale') subText = t('status.stale', { time })
    else if (freshness === 'fallback') subText = t('status.fallback', { time })
    else subText = t('status.fresh', { time })
  } else if (error) {
    subText = t('status.error', { msg: error })
  }

  let body: JSX.Element
  if (!data && !error) {
    body = (
      <div className="dsw-ust-empty">
        <div className="dsw-ust-empty-title">{t('status.loading')}</div>
        <div>{t('status.loading.hint')}</div>
      </div>
    )
  } else if (error && !data) {
    body = <div className="dsw-ust-empty">{t('status.error', { msg: error })}</div>
  } else if (allTimeTotal === 0 && data?.coverage.sessionsTotal === 0) {
    body = (
      <div className="dsw-ust-empty">
        <div className="dsw-ust-empty-title">{t('empty.title')}</div>
        <div>{t('empty.hint')}</div>
      </div>
    )
  } else {
    const overview = data!
    const sum = summary!
    body = (
      <>
        <KpiCards summary={sum} coverage={overview.coverage} i18n={i18n} />
        <Heatmap days={days} i18n={i18n} onTip={setHeatTip} />
        <BarChart days={barDays} byModel={sum.byModel} i18n={i18n} onTip={setBarTip} />
        <SessionsCard sessions={overview.topSessions} i18n={i18n} />
        <ProvidersCard providers={providersFor(overview, range)} i18n={i18n} />
        <ModelDonut byModel={sum.byModel} total={sum.totals.total} i18n={i18n} onTip={setDonutTip} />
      </>
    )
  }

  return (
    <div className="dsw-ust-root">
      <Tooltip tip={barTip} />
      <Tooltip tip={donutTip} />
      <Tooltip tip={heatTip} />
      <div className="dsw-ust-head">
        <div className="dsw-ust-head-title">
          <svg className="dsw-ust-page-icon" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
            <path d="M3 13V9.5" />
            <path d="M8 13V5.5" />
            <path d="M13 13V3" />
            <path d="M2 13.5h12" />
          </svg>
          <div>
            <h2>{t('nav.label')}</h2>
            {subText ? <div className="dsw-ust-sub">{subText}</div> : null}
          </div>
        </div>
        <div className="dsw-ust-head-actions">
          {data ? <ExportMenu overview={data} i18n={i18n} /> : null}
          <button
            className="dsw-ust-refresh"
            onClick={() => load(true)}
            disabled={loading}
            title={t('refresh.title')}
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            {loading ? t('refresh.loading') : t('refresh.button')}
          </button>
        </div>
      </div>
      {data ? (
        <div className="dsw-ust-capsule" role="group" aria-label={t('nav.label')}>
          {(['7d', '30d', 'all'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? 'on' : ''}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {t('range.' + r)}
            </button>
          ))}
        </div>
      ) : null}
      {body}
    </div>
  )
}
