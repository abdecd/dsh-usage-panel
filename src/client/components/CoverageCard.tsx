// dsh-usage-panel · coverage diagnostics card (P0-③).
// Honest disclosure: how many sessions scanned/failed/pending, data path
// mode, UTC timezone declaration, event range, retries and compaction — the
// overview never claims to be a complete bill when part of the corpus failed.
import type { CoverageStats } from '../../shared/contract.ts'
import { fmtTokens } from '../../shared/format.ts'
import type { I18n } from '../locales.ts'
import * as React from 'react'

interface CoverageCardProps {
  coverage: CoverageStats
  i18n: I18n
}

function clock(ts: number): string {
  const d = new Date(ts)
  return (
    String(d.getUTCFullYear()) +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  )
}

export function CoverageCard({ coverage, i18n }: CoverageCardProps): JSX.Element {
  const t = i18n.t
  const locale = i18n.locale
  const modeKey = coverage.mode === 'projection' ? 'coverage.mode.projection' : coverage.mode === 'scan' ? 'coverage.mode.scan' : 'coverage.mode.none'
  const range =
    coverage.from !== null && coverage.to !== null
      ? t('coverage.range', { from: clock(coverage.from), to: clock(coverage.to) })
      : '—'
  return (
    <div className="dsw-ust-card">
      <div className="dsw-ust-card-head">
        <div className="dsw-ust-card-title">
          <h3>{t('coverage.title')}</h3>
          <span className="dsw-ust-card-sub">{t('coverage.scope')}</span>
        </div>
        <span className="dsw-ust-card-sub">{t(modeKey)}</span>
      </div>
      <div className="dsw-ust-coverage">
        <span>
          {t('coverage.sessions', {
            ok: coverage.sessionsOk,
            total: coverage.sessionsTotal,
            failed: coverage.sessionsFailed,
            pending: coverage.sessionsPending,
          })}
        </span>
        <span>
          {t('coverage.depth', {
            main: coverage.usageSessionsMain,
            subagent: coverage.usageSessionsSubagent,
          })}
        </span>
        {coverage.mode === 'scan' ? <span>{t('coverage.events', { events: coverage.eventsCounted })}</span> : null}
        <span>{range}</span>
        {coverage.retries > 0 ? <span>{t('coverage.retries', { retries: coverage.retries })}</span> : null}
        {coverage.compactionTokens > 0 ? <span>{t('coverage.compaction', { tokens: fmtTokens(coverage.compactionTokens, locale) })}</span> : null}
        <span>
          <b>{coverage.timezone}</b>
        </span>
      </div>
      {coverage.sessionsFailed > 0 ? (
        <div className="dsw-ust-coverage" style={{ marginTop: 6 }}>
          <span className="warn">{t('coverage.partial')}</span>
        </div>
      ) : null}
    </div>
  )
}
