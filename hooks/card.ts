import type { Win } from '../types'
import { MINUTE } from './forecast'

export const toMs = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN

  return Number.isFinite(ms) ? Math.round(ms / MINUTE) * MINUTE : 0
}

type CardWindow = { label?: unknown; percentUsed?: unknown; resetsAt?: unknown }

/** The card's windows by the API's names; null when it has no weekly figure. */
export function fromCard(text: string): Win[] | null {
  const start = text.indexOf('{')

  if (start < 0) return null

  const data = JSON.parse(text.slice(start)) as {
    plan?: { status?: unknown; windows?: CardWindow[] }
  }

  if (data.plan?.status !== 'ok' || !Array.isArray(data.plan.windows)) return null

  const windows: Win[] = []

  for (const w of data.plan.windows) {
    const label = typeof w.label === 'string' ? w.label.toLowerCase() : ''

    if (typeof w.percentUsed !== 'number') continue

    const kind = label.startsWith('5-hour')
      ? 'five_hour'
      : label.startsWith('weekly') && label.includes('all models')
        ? 'seven_day'
        : label.startsWith('weekly')
          ? `seven_day_${label.split('·').pop()?.trim() ?? 'other'}`
          : null

    if (kind === null) continue

    windows.push({
      kind,
      pct: w.percentUsed,
      resetsAt: toMs(typeof w.resetsAt === 'string' ? w.resetsAt : undefined),
    })
  }

  return windows.some(w => w.kind === 'seven_day') ? windows : null
}
