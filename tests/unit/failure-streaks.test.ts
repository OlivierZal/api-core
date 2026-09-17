import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FAILURE_REMINDER_INTERVAL_MS,
  FailureStreaks,
} from '../../src/observability/failure-streaks.ts'

// The windows ride the monotonic clock, so the fake set names
// `performance` beside the timers, as `sync-manager.test.ts` does.
const fakeClocks: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'Date',
    'performance',
  ],
}

describe(FailureStreaks, () => {
  beforeEach(() => {
    vi.useFakeTimers(fakeClocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the failure that opens a streak', () => {
    const streaks = new FailureStreaks()

    expect(streaks.shouldReport('GET /devices', '503')).toBe(true)
  })

  it('holds back an unchanged failure inside the reminder window', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')

    vi.advanceTimersByTime(FAILURE_REMINDER_INTERVAL_MS - 1)

    expect(streaks.shouldReport('GET /devices', '503')).toBe(false)
  })

  it('reminds once the window has elapsed, then holds back again', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')

    vi.advanceTimersByTime(FAILURE_REMINDER_INTERVAL_MS)

    expect(streaks.shouldReport('GET /devices', '503')).toBe(true)
    expect(streaks.shouldReport('GET /devices', '503')).toBe(false)
  })

  it('reports a failure whose reason changed', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')

    expect(streaks.shouldReport('GET /devices', '404')).toBe(true)
  })

  it('keeps one streak per subject', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')

    expect(streaks.shouldReport('GET /context', '503')).toBe(true)
    expect(streaks.shouldReport('GET /devices', '503')).toBe(false)
  })

  it('answers the swallowed count when a streak closes', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')
    streaks.shouldReport('GET /devices', '503')

    expect(streaks.close('GET /devices')).toBe(2)
  })

  it('answers null for a subject that had no streak', () => {
    const streaks = new FailureStreaks()

    expect(streaks.close('GET /devices')).toBeNull()
  })

  it('reports in full again after its streak closed', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')
    streaks.close('GET /devices')

    expect(streaks.shouldReport('GET /devices', '503')).toBe(true)
  })

  it('forgets every streak when cleared', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')
    streaks.shouldReport('GET /context', '503')
    streaks.clear()

    expect(streaks.close('GET /devices')).toBeNull()
    expect(streaks.shouldReport('GET /context', '503')).toBe(true)
  })
})
