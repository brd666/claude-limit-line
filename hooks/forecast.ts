import type { Reading, Sample, Win } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** How the week goes: below plan, on plan, ahead of it, used up, or too early to say. */
export type Tone = 'under' | 'even' | 'over' | 'out' | 'early'

/** One figure of the short line: its name, drawn white, and its value, grey. */
export type BriefPart = { label: string; value: string }

/**
 * What the band and the command show: a headline and the plan under it; and
 * the one short line under the prompt, as `parts` to draw and `brief` text.
 */
export type Lines = {
  tone: Tone
  head: string
  plan: string
  brief: string
  parts: BriefPart[]
}

const short = (parts: BriefPart[]) => ({
  parts,
  brief: parts
    .map(part => (part.value === '' ? part.label : `${part.label} ${part.value}`))
    .join(' · '),
})

export const num = (x: number, digits = 1): string => x.toFixed(digits)

export const pct = (x: number): string =>
  Number.isInteger(x) ? String(x) : num(x, 1)

const whole = (x: number): string => String(Math.round(x))

/** Two resets within an hour of each other are the same week (the API's milliseconds wobble). */
export const sameWeek = (a: number, b: number): boolean => Math.abs(a - b) < HOUR

export function when(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  if (new Date(now).toDateString() === d.toDateString()) return `today ${hm}`

  return `${WEEKDAYS[d.getDay()]} ${hm}`
}

export type Forecast = {
  timeShare: number
  pace: number
  projected: number
  perDayNow: number
  perDayAllowed: number
  runsOutAt: number | null
  elapsed: number
}

/** The weekly window's pace as of `at`, the moment its reading was taken. */
export function forecast(week: Win, at: number): Forecast {
  const start = week.resetsAt - WEEK
  const elapsed = Math.min(Math.max(at - start, 0), WEEK)
  const left = Math.max(week.resetsAt - at, 0)
  const perHour = elapsed > 0 ? week.pct / (elapsed / HOUR) : 0
  const timeShare = (elapsed / WEEK) * 100
  const projected = week.pct + perHour * (left / HOUR)

  return {
    timeShare,
    pace: timeShare > 0 ? week.pct / timeShare : 0,
    projected,
    perDayNow: perHour * 24,
    perDayAllowed:
      left > 0 ? (Math.max(0, 100 - week.pct) / (left / HOUR)) * 24 : 0,
    runsOutAt:
      perHour > 0 && projected > 100
        ? at + ((100 - week.pct) / perHour) * HOUR
        : null,
    elapsed,
  }
}

/** The last day's spend per day, from this week's stored readings (six hours of them at least). */
export function recentPerDay(samples: Sample[], week: Win, at: number): number | null {
  const inDay = samples.filter(
    s => sameWeek(s.r, week.resetsAt) && s.t >= at - DAY && s.t <= at,
  )

  if (inDay.length === 0) return null

  const first = inDay.reduce((a, b) => (b.t < a.t ? b : a))
  const hours = (at - first.t) / HOUR

  if (hours < 6) return null

  return (Math.max(0, week.pct - first.p) / hours) * 24
}

/** Today's share of the weekly limit: what is spent since the day began, and the allowance. */
export type Today = { spent: number; allowance: number }

/**
 * Today, from local midnight (or the week's start, where that came later):
 * what of the limit is spent since, and the day's even share of what was left
 * when the day began, the rest being shared out over the days to the reset.
 *
 * The figure at midnight is the last stored reading before it; where none is
 * stored (the mod has not run since), the first one today stands in.
 */
export function today(samples: Sample[], week: Win, at: number): Today {
  const weekStart = week.resetsAt - WEEK
  const midnight = new Date(at)
  midnight.setHours(0, 0, 0, 0)
  const nextMidnight = new Date(midnight)
  nextMidnight.setDate(nextMidnight.getDate() + 1)
  const dayStart = Math.max(midnight.getTime(), weekStart)
  const dayEnd = Math.min(nextMidnight.getTime(), week.resetsAt)
  const inWeek = samples
    .filter(s => sameWeek(s.r, week.resetsAt))
    .sort((a, b) => a.t - b.t)
  const before = inWeek.filter(s => s.t <= dayStart)
  const firstToday = inWeek.find(s => s.t > dayStart && s.t <= at)
  const atStart =
    dayStart === weekStart
      ? 0
      : Math.min(
          week.pct,
          before.length > 0 ? before[before.length - 1].p : (firstToday?.p ?? week.pct),
        )
  const span = week.resetsAt - dayStart

  return {
    spent: Math.max(0, week.pct - atStart),
    allowance: span > 0 ? (Math.max(0, 100 - atStart) * (dayEnd - dayStart)) / span : 0,
  }
}

/** Adds the reading's weekly percent to the samples; keeps this week's, oldest first. */
export function remember(samples: Sample[], reading: Reading): Sample[] {
  const week = reading.windows.find(w => w.kind === 'seven_day')

  if (!week || week.resetsAt === 0) return samples

  const kept = samples
    .filter(s => sameWeek(s.r, week.resetsAt))
    .sort((a, b) => a.t - b.t)
  const last = kept[kept.length - 1]
  const isSame =
    last !== undefined &&
    last.p === week.pct &&
    Math.abs(reading.at - last.t) < 30 * MINUTE

  if (isSame) return kept

  return [...kept, { t: reading.at, p: week.pct, r: week.resetsAt }]
    .sort((a, b) => a.t - b.t)
    .slice(-400)
}

/** The band's two lines for a reading, as of `now`. */
export function describe(reading: Reading, samples: Sample[], now: number): Lines | null {
  const week = reading.windows.find(w => w.kind === 'seven_day')

  if (!week) return null

  // Readings come with Claude's answers: say so when this one is old.
  const stale =
    now - reading.at > 15 * MINUTE ? [`data from ${when(reading.at, now)}`] : []
  // "Week" is how much of the week has passed, "Used" how much of the limit is spent.
  const used = `Used ${pct(week.pct)}%`
  const five = reading.windows.find(w => w.kind === 'five_hour')
  // The five-hour window, as a bare figure at the end of the headline.
  const fiveHour = five ? ` · 5h ${pct(five.pct)}%` : ''
  const usedPart: BriefPart = { label: 'Used', value: `${pct(week.pct)}%` }
  const fivePart: BriefPart[] = five ? [{ label: '5h', value: `${pct(five.pct)}%` }] : []

  if (week.resetsAt === 0) {
    return {
      tone: 'early',
      head: `${used}${fiveHour}`,
      plan: stale.join(''),
      ...short([usedPart, ...fivePart]),
    }
  }

  const f = forecast(week, reading.at)
  const passed = `Week ${whole(f.timeShare)}% · ${used}`
  const budget = `${num(f.perDayAllowed)}%/day`
  const passedParts: BriefPart[] = [
    { label: 'Week', value: `${whole(f.timeShare)}%` },
    usedPart,
  ]
  // Spent today, of today's even share of what is left.
  const day = today(samples, week, reading.at)
  const todayPart: BriefPart = {
    label: 'today',
    value: `${whole(day.spent)}/${whole(day.allowance)}%`,
  }
  const todayPlan = `today ${whole(day.spent)}% of ${whole(day.allowance)}%`

  if (week.pct >= 100) {
    return {
      tone: 'out',
      head: `${passed} — limit reached${fiveHour}`,
      plan: stale.join(''),
      ...short([...passedParts, { label: 'limit reached', value: '' }, ...fivePart]),
    }
  }

  if (f.elapsed < 6 * HOUR) {
    return {
      tone: 'early',
      head: `${passed} · too early for pace${fiveHour}`,
      plan: [`can spend ${budget}`, todayPlan, ...stale].join(' · '),
      ...short([...passedParts, todayPart, ...fivePart]),
    }
  }

  const recent = recentPerDay(samples, week, reading.at)
  const rate =
    recent === null ? `avg ${num(f.perDayNow)}%/day` : `now ${num(recent)}%/day`
  const tone: Tone =
    f.projected > 100 ? 'over' : f.projected >= 85 ? 'even' : 'under'
  const verdict = {
    under: 'under budget',
    even: 'on track',
    over: 'ahead of budget',
  }[tone]
  const head = `${passed} · pace ${num(f.pace, 2)}× — ${verdict}${fiveHour}`

  if (tone === 'over' && f.runsOutAt !== null) {
    return {
      tone,
      head,
      plan: [
        `runs out ${when(f.runsOutAt, now)}`,
        `keep under ${budget}, ${rate}`,
        todayPlan,
        ...stale,
      ].join(' · '),
      ...short([
        ...passedParts,
        { label: 'runs out', value: when(f.runsOutAt, now) },
        todayPart,
        ...fivePart,
      ]),
    }
  }

  const unused = tone === 'under' ? `, ${whole(100 - f.projected)}% unused` : ''

  return {
    tone,
    head,
    plan: [
      `forecast ~${whole(f.projected)}%${unused}`,
      `can spend ${budget}, ${rate}`,
      todayPlan,
      ...stale,
    ].join(' · '),
    ...short([
      ...passedParts,
      { label: 'fc', value: `~${whole(f.projected)}%` },
      todayPart,
      ...fivePart,
    ]),
  }
}
