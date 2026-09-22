import { describe, expect, it } from 'vitest'

// The value surface of the root barrel, in code-unit order: ASCII
// identifiers, so no collation is involved and the list never moves
// with an ICU upgrade.
const byCodeUnit = (first: string, second: string): number => {
  if (first === second) {
    return 0
  }
  return first < second ? -1 : 1
}

const EXPECTED = [
  'APICallLogData',
  'APICallRequestData',
  'APICallResponseData',
  'APIError',
  'AuthRetryPolicy',
  'AuthenticationError',
  'AuthenticationThrottledError',
  'BASE_SENSITIVE_KEYS',
  'CompositePolicy',
  'DEFAULT_TRANSIENT_RETRY_OPTIONS',
  'DisposableTimeout',
  'FAILURE_REMINDER_INTERVAL_MS',
  'FailureStreaks',
  'HttpClient',
  'HttpError',
  'HttpStatus',
  'Intl',
  'LifecycleEmitter',
  'MS_PER_DAY',
  'MS_PER_MINUTE',
  'MS_PER_SECOND',
  'REDACTED',
  'RateLimitError',
  'RateLimitGate',
  'RateLimitPolicy',
  'RegistrySyncError',
  'RetryGuard',
  'SESSION_REFRESH_AHEAD_MS',
  'SessionAPI',
  'SyncManager',
  'Temporal',
  'TransientRetryPolicy',
  'ValidationError',
  'baseRedaction',
  'createAPICallErrorData',
  'createRedaction',
  'failureReason',
  'fireAndForget',
  'formatDurationHuman',
  'isAPIError',
  'isHttpError',
  'isSessionExpired',
  'isTransientServerError',
  'readHeaders',
  'setting',
  'syncDevices',
  'withRetryBackoff',
]

// Imports the ROOT barrel (the other suites reach modules directly), so
// the barrel executes under coverage and the published surface is
// pinned both ways: a drop AND an addition of a value export fail here
// before a consumer's adoption train finds the hole. An intentional
// barrel change edits this list and re-counts the CLAUDE.md ledger.
describe('public surface', () => {
  it('exports exactly the pinned value names from the root barrel', async () => {
    const api = await import('../../src/index.ts')

    expect(Object.keys(api).toSorted(byCodeUnit)).toStrictEqual(EXPECTED)
  })
})
