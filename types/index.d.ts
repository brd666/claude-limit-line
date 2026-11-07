/** One rate-limit window as the mod keeps it: `resetsAt` in ms, rounded to the minute (0 when unknown). */
export type Win = { kind: string; pct: number; resetsAt: number }

/**
 * The windows of one reading and when it was taken (ms). `source`: `card` is
 * the app's usage card (what its usage circle shows), `api` the figures the
 * last API response carried; absent on readings stored before it existed.
 */
export type Reading = { windows: Win[]; at: number; source?: 'card' | 'api' }

/** One weekly reading kept for the recent pace: time, percent, the week's reset. */
export type Sample = { t: number; p: number; r: number }

/**
 * Where the figures show: `line` the status line under the prompt,
 * `band` above the prompt, `pane` in a panel beside the chat.
 */
export type View = 'line' | 'band' | 'pane'

declare module 'claude-code' {
  interface PluginState {
    'l': {
      reading: Shaped<Reading | null>
      samples: Shaped<Sample[]>
      tick: number
      view: View
      paneUp: boolean
    }
  }
}
