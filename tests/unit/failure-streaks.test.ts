import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FAILURE_REMINDER_INTERVAL_MS,
  FailureStreaks,
  failureReason,
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

  it('answers how many failures the streak counted when it closes', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '503')
    streaks.shouldReport('GET /devices', '503')

    expect(streaks.close('GET /devices')).toBe(2)
  })

  it('counts every reason of one episode when it closes', () => {
    const streaks = new FailureStreaks()
    streaks.shouldReport('GET /devices', '500')
    streaks.shouldReport('GET /devices', '404')
    streaks.shouldReport('GET /devices', '500')

    expect(streaks.close('GET /devices')).toBe(3)
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

  it('answers whether a subject has an open streak', () => {
    const streaks = new FailureStreaks()

    expect(streaks.has('GET /devices')).toBe(false)

    streaks.shouldReport('GET /devices', '503')

    expect(streaks.has('GET /devices')).toBe(true)

    streaks.close('GET /devices')

    expect(streaks.has('GET /devices')).toBe(false)
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

describe(failureReason, () => {
  it('names an error by its name and message', () => {
    expect(failureReason(new TypeError('boom'))).toBe('TypeError: boom')
  })

  it('names a primitive by its own value', () => {
    expect(failureReason('offline')).toBe('offline')
    expect(failureReason(404)).toBe('404')
  })

  // Its default stringification says nothing, and a walk over it could
  // print a credential.
  it('names any other object by its type alone', () => {
    expect(failureReason({ password: 'secret' })).toBe('a thrown object')
  })
})
