import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Reading, Sample, View, Win } from '../types'
import { fromCard, toMs } from './card'
import { MINUTE, describe, remember } from './forecast'
import type { Tone } from './forecast'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const reading = atom({ plugin: 'lm', key: 'reading' } as const, null, {
  shape: 'reading-1',
})
const samples = atom({ plugin: 'lm', key: 'samples' } as const, [], {
  shape: 'samples-1',
})
// Moves once a minute so the figures redraw between turns.
const tick = atom({ plugin: 'lm', key: 'tick' } as const, 0)
// Where the figures show (View): beside the model and mode under the prompt
// until the person picks the band or the pane with /limit.
const view = atom({ plugin: 'lm', key: 'view' } as const, 'line')
// Whether the pane is placed on screen now; while it is not, the band stands in.
const paneUp = atom({ plugin: 'lm', key: 'paneUp' } as const, false)

const PANE = 'limit-pace'
const PANE_TITLE = 'Limit'

// $.store keys, shared by every session: the last reading, the week's samples,
// the person's View (the desktop docks a pane full height, so never the
// default), and what the last card read, pane open and line draw came to.
const STORE_READING = 'reading-1'
const STORE_SAMPLES = 'samples-1'
const STORE_VIEW = 'view-1'
const STORE_CARD = 'card-1'
const STORE_PANE = 'pane-1'
const STORE_LOADED = 'loaded-1'
// Bumped with each change, so a check from outside sees which code runs.
const VERSION = '0.1.1'

// The desktop app's usage card: the figures its usage circle shows. The API
// responses' own figures lag it by a point or so.
const CARD_TOOL = 'mcp__ccd_session_mgmt__get_usage'
const CARD_EVERY = 2 * MINUTE
// While the card answered this recently, the API's figures do not replace it.
const CARD_FRESH = 5 * MINUTE

const COLOR: Record<Tone, string> = {
  under: 'suggestion',
  even: 'success',
  over: 'warning',
  out: 'error',
  early: 'text',
}

/** Background work from a timer or a draw: a failure skips that round, no more. */
function quietly(work: Promise<unknown>) {
  work.catch(() => undefined)
}

function fromApi(limits: readonly SessionRateLimit[]): Win[] {
  return limits.map(limit => ({
    kind: limit.kind,
    pct: limit.percentUsed,
    resetsAt: toMs(limit.resetsAt),
  }))
}

function isReading(value: unknown): value is Reading {
  const r = value as Reading | null

  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.at === 'number' &&
    Array.isArray(r.windows)
  )
}

function isSamples(value: unknown): value is Sample[] {
  return (
    Array.isArray(value) &&
    value.every(s => typeof s?.t === 'number' && typeof s?.p === 'number')
  )
}

async function keep($: EngineInterface, r: Reading) {
  await update($, reading, () => r)
  await $.store.set(STORE_READING, r)

  // Another session may have added samples since: start from the store's.
  const stored = await $.store.get(STORE_SAMPLES)
  const base = isSamples(stored) ? stored : await read($, samples)
  const kept = remember(base, r)
  await update($, samples, () => kept)
  await $.store.set(STORE_SAMPLES, kept)
  await showStatus($)
}

/**
 * The line under the prompt: the plugin's status line, which the desktop app
 * draws beside the model's name, right-aligned, and cuts when it does not fit.
 * The app heads it with the plugin's name, which is why that name is short.
 */
async function showStatus($: EngineInterface) {
  if ((await read($, view)) !== 'line') {
    $.ui.status(undefined)

    return
  }

  const r = await read($, reading)
  const lines = r ? describe(r, await read($, samples), await $.clock.now()) : null
  $.ui.status(lines?.brief)
}

async function setView($: EngineInterface, next: View) {
  await update($, view, () => next)
  await $.store.set(STORE_VIEW, next)

  if (next !== 'pane' && (await $.ui.panes()).some(p => p.id === PANE)) {
    await update($, paneUp, () => false)
    await $.ui.close({ id: PANE })
  }

  await showStatus($)
}

/**
 * Reads the app's usage card. Only where the session's permissions already
 * allow the tool, so it never opens a permission dialog; where the tool is
 * absent (a terminal session) or refused, answers false and the API's
 * figures stand.
 */
async function readCard($: EngineInterface): Promise<boolean> {
  const at = await $.clock.now()
  let outcome = 'ok'

  try {
    const { decision } = await $.tool.check({ tool: CARD_TOOL, input: {} })

    if (decision !== 'allow') {
      outcome = `not allowed (${decision})`

      return false
    }

    const answer = await $.tool.call({ tool: CARD_TOOL })

    if (answer.deny !== undefined || answer.isError || !answer.text) {
      outcome = 'no answer'

      return false
    }

    const windows = fromCard(answer.text)

    if (windows === null) {
      outcome = 'no weekly figure'

      return false
    }

    await keep($, { windows, at, source: 'card' })

    return true
  } catch (error) {
    outcome = `failed: ${error instanceof Error ? error.message : String(error)}`

    return false
  } finally {
    // What the last attempt came to, for checking from outside the session.
    await $.store.set(STORE_CARD, { at, outcome })
  }
}

async function readApi($: EngineInterface, limits: readonly SessionRateLimit[]) {
  if (limits.length === 0) return

  const now = await $.clock.now()
  const last = await read($, reading)
  const isCardFresh = last?.source === 'card' && now - last.at < CARD_FRESH

  if (!isCardFresh) {
    await keep($, { windows: fromApi(limits), at: now, source: 'api' })
  }
}

async function showPane($: EngineInterface) {
  await setView($, 'pane')
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  await update($, paneUp, () => opened.isPlaced)
  // Whether the app placed it, for checking from outside the session.
  await $.store.set(STORE_PANE, {
    at: await $.clock.now(),
    isPlaced: opened.isPlaced,
    reason: opened.isPlaced ? '' : opened.reason,
  })
}

async function checkPane($: EngineInterface) {
  const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  if ((await read($, paneUp)) !== isUp) await update($, paneUp, () => isUp)
}

async function summary($: EngineInterface): Promise<string> {
  const r = await read($, reading)

  if (!r) return 'No limit data yet: it comes with Claude’s first answer here.'

  const lines = describe(r, await read($, samples), await $.clock.now())

  if (!lines) return 'No weekly limit figure yet.'

  return [lines.head, lines.plan].filter(Boolean).join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'limit',
      description: 'Weekly limit: usage, pace and forecast',
      argumentHint: '[line | band | panel]',
    })

    await $.store.set(STORE_LOADED, { at: await $.clock.now(), version: VERSION })
    const chosen = await $.store.get(STORE_VIEW)
    const picked: View = chosen === 'band' || chosen === 'pane' ? chosen : 'line'
    await update($, view, () => picked)

    if (picked === 'pane') {
      quietly(showPane($))
    } else if ((await $.ui.panes()).some(p => p.id === PANE)) {
      // A pane an earlier version opened stays up across a reload: close it.
      await update($, paneUp, () => false)
      quietly($.ui.close({ id: PANE }))
    }

    const stored = await $.store.get(STORE_SAMPLES)
    if (isSamples(stored)) await update($, samples, () => stored)

    // Until a fresher figure arrives, show the last one any session kept.
    const last = await $.store.get(STORE_READING)
    if (isReading(last)) await update($, reading, () => last)

    await readApi($, (await $.session.usage()).rateLimits)
    await showStatus($)

    // The card is read off the start, so a slow answer never holds it up.
    $.clock.after(1_000, () => {
      quietly(readCard($))
    })
    // A line sent before the app has joined a new chat is lost: send it again
    // once the app is there.
    for (const wait of [3_000, 10_000]) {
      $.clock.after(wait, () => {
        quietly(showStatus($))
      })
    }
    $.clock.every(CARD_EVERY, () => {
      quietly(readCard($))
    })
    $.clock.every(MINUTE, () => {
      quietly(update($, tick, n => n + 1))
      quietly(checkPane($))
      quietly(showStatus($))
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await readApi($, e.rateLimits)
    // An answer just spent some of the limit: ask the card again soon.
    $.clock.after(5_000, () => {
      quietly(readCard($))
    })

    return next(e)
  })

  on('command.run', { command: 'limit' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'panel' || arg === 'pane') {
      await showPane($)

      return { text: 'The limit is in the panel now.' }
    }

    if (arg === 'band') {
      await setView($, 'band')

      return { text: 'The limit is above the prompt now.' }
    }

    if (arg === 'line') {
      await setView($, 'line')

      return { text: 'The limit is beside the model now.' }
    }

    await readCard($)

    return { text: await summary($) }
  })

  // Closing the pane by its own mark is the same as its button: back to the line.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)

    if (e.origin.kind === 'person') {
      await update($, paneUp, () => false)
      await update($, view, () => 'line')
      await $.store.set(STORE_VIEW, 'line')
    }

    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    await read($, tick)
    const r = await read($, reading)
    const lines = r ? describe(r, await read($, samples), await $.clock.now()) : null

    return (
      <Box flexDirection="column">
        {lines === null ? (
          <Text dimColor>No limit data yet.</Text>
        ) : (
          <Text color={COLOR[lines.tone]} weight="semibold">
            {lines.head}
          </Text>
        )}
        {lines !== null &&
          lines.plan !== '' &&
          lines.plan.split(' · ').map(part => <Text dimColor>{part}</Text>)}
        <Box marginTop={1}>
          <Button key="close" label="Close" onPress={() => setView($, 'line')} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // The band shows when picked, and stands in for a pane not on screen.
    const picked = await read($, view)
    const isShown =
      picked === 'band' || (picked === 'pane' && !(await read($, paneUp)))

    if (!isShown) return next(e)

    await read($, tick)
    const r = await read($, reading)

    if (!r) return next(e)

    const lines = describe(r, await read($, samples), await $.clock.now())

    if (!lines) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text color={COLOR[lines.tone]} weight="semibold">
          {lines.head}
        </Text>
        {lines.plan !== '' && <Text dimColor>{lines.plan}</Text>}
      </Box>
    )
  })
}
