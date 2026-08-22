// dsh-usage-panel · pure aggregation helpers (shared by host paths and tests).
// Semantics preserved from v0.1.0 unless the strategy explicitly changed them
// (the one intended change: day keys are UTC, not local time).
import type { Buckets, DayRecord, ModelItem, UsageTotals } from './contract.ts'

export const HEAT_DAYS = 182 // ~26 weeks for the contribution heatmap (recent half-year)
export const RECENT_DAYS = 30 // recent window for totals / model split / bars
export const WEEK_DAYS = 7 // short window for the KPI / chart range switch

/** A windowed roll-up derived client-side from the per-day records. */
export interface WindowSummary {
  totals: UsageTotals
  byModel: ModelItem[]
}

/** A windowed roll-up plus the host-counted distinct sessions for the window. */
export interface RangeSummary extends WindowSummary {
  sessionCount: number
}

/**
 * Sum the last `nDays` day records into a windowed totals + per-model ranking.
 * Pure: `days` is the fixed-length heatmap window, so `nDays` must be ≤ the
 * array length (callers pass WEEK_DAYS / RECENT_DAYS, both ≤ HEAT_DAYS).
 */
export function windowFromDays(days: DayRecord[], nDays: number): WindowSummary {
  const slice = days.slice(-nDays)
  const byModel: Record<string, Buckets> = {}
  const totals = emptyTotals()
  for (const day of slice) {
    for (const model of Object.keys(day.models)) {
      const m = day.models[model]!
      const b = byModel[model] || (byModel[model] = emptyBuckets())
      b.input += m.input
      b.output += m.output
      b.cacheRead += m.cacheRead
      b.cacheWrite += m.cacheWrite
      totals.input += m.input
      totals.output += m.output
      totals.cacheRead += m.cacheRead
      totals.cacheWrite += m.cacheWrite
    }
  }
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  return { totals, byModel: sortedModels(byModel) }
}

export function emptyBuckets(): Buckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function emptyTotals(): UsageTotals {
  return { ...emptyBuckets(), total: 0 }
}

/** Add a raw (possibly partial/null) TokenUsage-like value into a bucket set. */
export function addBuckets(target: Buckets, usage: Partial<Buckets> | null | undefined): void {
  if (!usage) return
  target.input += Number(usage.input) || 0
  target.output += Number(usage.output) || 0
  target.cacheRead += Number(usage.cacheRead) || 0
  target.cacheWrite += Number(usage.cacheWrite) || 0
}

/** Merge one bucket set into another (values already normalized). */
export function mergeInto(target: Buckets, src: Buckets): void {
  target.input += src.input
  target.output += src.output
  target.cacheRead += src.cacheRead
  target.cacheWrite += src.cacheWrite
}

export function totalsFrom(b: Buckets): UsageTotals {
  return { ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite }
}

/** Sorted model ranking, most usage first (v0.1.0 semantic). */
export function sortedModels(map: Record<string, Buckets>): ModelItem[] {
  return Object.keys(map)
    .map((model) => {
      const b = map[model]!
      return { model, ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite }
    })
    .sort((a, b) => b.total - a.total)
}

export function totalsFromModels(models: ModelItem[]): UsageTotals {
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

/** UTC day key for a timestamp: YYYY-MM-DD (explicit timezone declaration). */
export function dayKeyUTC(ts: number): string {
  const d = new Date(ts)
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  )
}

/** Parse a UTC YYYY-MM-DD key into a Date at UTC midnight (never local). */
export function parseDayKeyUTC(key: string): Date {
  const p = key.split('-')
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])))
}

/** Format a Date's UTC calendar day as a day key. */
export function keyOfDateUTC(d: Date): string {
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  )
}

export function todayKeyUTC(now: number): string {
  return dayKeyUTC(now)
}

/**
 * Build the 182-day heatmap window ending today (UTC). Days with no usage get
 * zero-filled records, preserving the v0.1.0 grid shape (fixed-length array).
 */
export function buildDayWindow(byDay: Record<string, Record<string, Buckets>>, now: number): DayRecord[] {
  const days: DayRecord[] = []
  const today = todayKeyUTC(now)
  const todayDate = parseDayKeyUTC(today)
  for (let i = HEAT_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), todayDate.getUTCDate() - i))
    const key = keyOfDateUTC(d)
    const record = byDay[key]
    const models: Record<string, UsageTotals> = {}
    let total = 0
    if (record) {
      for (const model of Object.keys(record)) {
        const b = record[model]!
        models[model] = totalsFrom(b)
        total += models[model]!.total
      }
    }
    days.push({ date: key, total, models })
  }
  return days
}

/** Cache hit rate over the four disjoint buckets: read / (uncached + read + write). */
export function hitRate(b: Buckets): number | null {
  const denominator = b.input + b.cacheRead + b.cacheWrite
  if (denominator <= 0) return null
  return b.cacheRead / denominator
}

/** Billed input (uncached + cache read + cache write) — the v0.1.0 "输入" number. */
export function billedInput(b: Buckets): number {
  return b.input + b.cacheRead + b.cacheWrite
}
