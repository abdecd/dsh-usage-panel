// dsh-usage-panel · shared client hooks and helpers.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { I18n } from './locales.ts'

export const PALETTE = ['#4f8cff', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#14b8a6']

/** Top-5 models with stable colors + a merged "其他/other" row (v0.1.0). */
export interface ModelRow {
  model: string
  total: number
  color: string | null
  rest: boolean
}

export function modelRows(byModel: Array<{ model: string; total: number }>, otherLabel: string): ModelRow[] {
  const rows: ModelRow[] = []
  for (let i = 0; i < byModel.length && i < 5; i++) {
    rows.push({ model: byModel[i]!.model, total: byModel[i]!.total, color: PALETTE[i % PALETTE.length]!, rest: false })
  }
  if (byModel.length > 5) {
    rows.push({ model: otherLabel, total: byModel.slice(5).reduce((s, m) => s + m.total, 0), color: null, rest: true })
  }
  return rows
}

/** Count-up hook (easeOutCubic) driving the KPI number entrance (v0.1.0). */
export function useCountUp(target: number, duration: number): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const start = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(target * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [target, duration])
  return value
}

/** Subscribe a component to locale switches (re-renders on 'locale/change'). */
export function useI18n(i18n: I18n): I18n {
  const subscribe = useCallback((cb: () => void) => i18n.subscribe(cb), [i18n])
  const active = useSyncExternalStore(subscribe, i18n.getSnapshot, i18n.getSnapshot)
  return active === i18n.locale ? i18n : { ...i18n, locale: active }
}

/** Keep a ref of the latest value without re-rendering (for effect deps). */
export function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** Simple auto-hide for popup menus. */
export function useClickAway(onAway: () => void): (node: HTMLElement | null) => void {
  const ref = useRef<HTMLElement | null>(null)
  const cbRef = useLatest(onAway)
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      if (ref.current) document.removeEventListener('mousedown', handle)
      ref.current = node
      if (node) document.addEventListener('mousedown', handle)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  function handle(e: MouseEvent): void {
    if (ref.current && !ref.current.contains(e.target as Node)) cbRef.current()
  }
  useEffect(() => () => document.removeEventListener('mousedown', handle), [])
  return setRef
}

/** Tooltip payload shared by all charts. */
export interface Tip {
  left: number
  top: number
  title: string
  lines: Array<{ label: string; value: string; color?: string | null }>
}
