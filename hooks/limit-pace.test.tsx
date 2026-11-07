import { expect, test } from 'claude-code/testing'

import { fromCard } from './card'
import { HOUR, describe, forecast, remember, when } from './forecast'

// A weekly window that resets on a Wednesday, read on the Saturday before it
// with 26% used: 37% of the week gone.
const RESET = Date.parse('2026-11-11T14:00:00Z')
const NOW = Date.parse('2026-11-07T04:23:00Z')

const READING = {
  windows: [
    { kind: 'five_hour', pct: 20, resetsAt: Date.parse('2026-11-07T07:30:00Z') },
    { kind: 'seven_day', pct: 26, resetsAt: RESET },
  ],
  at: NOW,
}

const BAND = {
  plugin: 'l',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'l',
  component: 'Pane',
  requestId: 'limit-pace',
  props: {
    title: 'Limit',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const


// The mod's own values as a session holds them: where it shows, the pane.
const seed =
  (where: 'line' | 'band' | 'pane', isUp: boolean) =>
  (_: unknown, e: { key: string }) => {
    if (e.key === 'reading') {
      return { value: { value: { shape: 'reading-1', value: READING }, version: 1 } }
    }
    if (e.key === 'samples') {
      return { value: { value: { shape: 'samples-1', value: [] }, version: 1 } }
    }
    if (e.key === 'view') return { value: { value: where, version: 1 } }
    if (e.key === 'paneUp') return { value: { value: isUp, version: 1 } }

    return { value: { value: 0, version: 1 } }
  }

test('26% by Saturday 11:23 is below plan, about 70% by the reset', async () => {
  const f = forecast({ kind: 'seven_day', pct: 26, resetsAt: RESET }, NOW)

  expect(Math.round(f.timeShare)).toBe(37)
  expect(f.pace.toFixed(2)).toBe('0.70')
  expect(Math.round(f.projected)).toBe(70)
  expect(f.perDayAllowed.toFixed(1)).toBe('16.8')
  expect(f.runsOutAt).toBe(null)
})

test('60% by Saturday runs out before the reset', async () => {
  const f = forecast({ kind: 'seven_day', pct: 60, resetsAt: RESET }, NOW)

  expect(f.projected > 100).toBe(true)
  expect((f.runsOutAt ?? Infinity) < RESET).toBe(true)
})

test('samples keep this week only and skip an unchanged reading', async () => {
  const old = { t: NOW - 8 * 24 * HOUR, p: 90, r: RESET - 7 * 24 * HOUR }
  const one = remember([old], READING)

  expect(one.length).toBe(1)
  expect(one[0].p).toBe(26)
  expect(remember(one, { ...READING, at: NOW + 60_000 }).length).toBe(1)
})

test('the short line has the forecast and the average a day, no verdict', async () => {
  const lines = describe(READING, [], NOW + 60_000)

  expect(lines?.brief).toBe(
    'Week 37% · Used 26% · fc ~70% · avg 10.0 → 16.8%/d · 5h 20%',
  )
})

test('the band shows the pace on every surface, when picked', async ($, on) => {
  on('clock.now', () => ({ value: NOW + 2 * 60_000 }))
  on('state.get', seed('band', false))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const head = await ui.find({ type: 'Text', text: /^Week/ })
    const plan = await ui.find({ type: 'Text', text: /^forecast/ })

    expect(head?.text).toBe(
      'Week 37% · Used 26% · pace 0.70× — under budget · 5h 20%',
    )
    expect(plan?.text).toBe(
      'forecast ~70%, 30% unused · can spend 16.8%/day, avg 10.0%/day',
    )
    expect(await ui.find({ type: 'Text', text: /reset/i })).toBe(undefined)
    await ui.unmount()
  }
})

test('the band stays away while the line is picked', async ($, on) => {
  on('clock.now', () => ({ value: NOW + 60_000 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('state.get', seed('line', false))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Week/ })).toBe(undefined)
  await ui.unmount()
})

test('ahead of budget says when it runs out; an old reading says so', async () => {
  const ahead = {
    windows: [{ kind: 'seven_day', pct: 60, resetsAt: RESET }],
    at: NOW,
  }
  const lines = describe(ahead, [], NOW + 20 * 60_000)

  expect(lines?.tone).toBe('over')
  expect(lines?.head).toBe('Week 37% · Used 60% · pace 1.62× — ahead of budget')
  expect(lines?.plan.startsWith('runs out ')).toBe(true)
  expect(lines?.plan.includes('keep under 9.1%/day, avg 23.1%/day')).toBe(true)
  expect(lines?.plan.endsWith(`data from ${when(NOW, NOW + 20 * 60_000)}`)).toBe(true)
  expect(lines?.brief.includes('runs out ')).toBe(true)
  // Ahead of budget the average to land on 100% is below the one so far.
  expect(lines?.brief.endsWith('avg 23.1 → 9.1%/d')).toBe(true)
})

// What the desktop app's usage card answers (trimmed), with 27% used.
const CARD = JSON.stringify({
  plan: {
    status: 'ok',
    windows: [
      { label: '5-hour limit', percentUsed: 25, resetsAt: '2026-11-07T07:30:00.430Z' },
      { label: 'Weekly · all models', percentUsed: 27, resetsAt: '2026-11-11T14:00:00.430Z' },
      { label: 'Weekly · Fable', percentUsed: 0, resetsAt: '2026-11-11T14:00:00.000Z' },
    ],
  },
  context: { session: 'self', status: 'ok' },
})

test('the usage card is read by the names the API uses', async () => {
  const windows = fromCard(CARD)

  expect(windows?.find(w => w.kind === 'seven_day')?.pct).toBe(27)
  expect(windows?.find(w => w.kind === 'seven_day')?.resetsAt).toBe(RESET)
  expect(windows?.find(w => w.kind === 'five_hour')?.pct).toBe(25)
  expect(windows?.some(w => w.kind === 'seven_day_fable')).toBe(true)
  expect(fromCard(JSON.stringify({ plan: { status: 'unavailable' } }))).toBe(null)
})

test('/limit reads the card when the tool is allowed', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {}, text: CARD }))
  const statuses: unknown[] = []
  on('ui.status', (_, e) => {
    statuses.push(e)

    return { value: undefined }
  })

  const answer = await $.command.run({
    command: 'limit',
    args: '',
    origin: { kind: 'human' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(String(answer.text).startsWith('Week 37% · Used 27%')).toBe(true)
  expect(String(answer.text).includes('5h 25%')).toBe(true)
  expect(JSON.stringify(statuses.at(-1))).toContain(
    'Week 37% · Used 27% · fc ~73% · avg 10.4 → 16.6%/d · 5h 25%',
  )
})

test('/limit opens no dialog where the tool is not allowed', async ($, on) => {
  let calls = 0
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => {
    calls += 1

    return { result: {}, text: CARD }
  })

  await $.command.run({
    command: 'limit',
    args: '',
    origin: { kind: 'human' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(calls).toBe(0)
})

test('the pane shows the figures and its one button puts the line back', async ($, on) => {
  const closed: string[] = []
  const stored: Record<string, unknown> = {}
  on('clock.now', () => ({ value: NOW + 60_000 }))
  // The pane's own writes land here, and later reads see them.
  const written = new Map<string, { value: unknown; version: number }>()
  const first = seed('pane', true)
  on('state.get', (_, e) => {
    const held = written.get(e.key)

    return held ? { value: held } : first(_, e)
  })
  on('state.set', (_, e) => {
    const version = (written.get(e.key)?.version ?? 1) + 1
    written.set(e.key, { value: e.value, version })

    return { value: { isSet: true, version } }
  })
  on('store.set', (_, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [
      { id: 'limit-pace', title: 'Limit', isShown: true, isFocused: false, isPlaced: true },
    ],
  }))
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^Week 37%/ }))?.text).toBe(
      'Week 37% · Used 26% · pace 0.70× — under budget · 5h 20%',
    )
    await ui.press({ key: 'close' })
    expect(closed.includes('limit-pace')).toBe(true)
    expect(stored['view-1']).toBe('line')
    expect(written.get('view')?.value).toBe('line')
    expect(written.get('paneUp')?.value).toBe(false)
    written.clear()
    closed.length = 0
    await ui.unmount()
  }
})

test('a pane that is not placed leaves the band up', async ($, on) => {
  on('clock.now', () => ({ value: NOW + 60_000 }))
  on('state.get', seed('pane', false))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Week/ }))?.text.startsWith('Week 37%')).toBe(true)
  await ui.unmount()
})

test('the status line carries the whole short line, and leaves for the band', async ($, on) => {
  const statuses: unknown[] = []
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {}, text: CARD }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', (_, e) => {
    statuses.push(e)

    return { value: undefined }
  })
  const run = (args: string) =>
    $.command.run({
      command: 'limit',
      args,
      origin: { kind: 'human' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  await run('')
  expect(JSON.stringify(statuses.at(-1))).toContain(
    'Week 37% · Used 27% · fc ~73% · avg 10.4 → 16.6%/d · 5h 25%',
  )

  await run('band')
  expect(JSON.stringify(statuses.at(-1))).not.toContain('Week')
})
