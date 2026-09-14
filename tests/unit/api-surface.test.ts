import { describe, expect, it } from 'vitest'

// The value surface of the root barrel, in the order `byName` yields —
// the locale is pinned so the expectation does not follow the runtime's
// default collation.
const byName = (first: string, second: string): number =>
  first.localeCompare(second, 'en')

const EXPECTED = [
  'APICallLogData',
  'APICallRequestData',
  'APICallResponseData',
  'APIError',
  'AuthenticationError',
  'AuthenticationThrottledError',
  'AuthRetryPolicy',
  'BASE_SENSITIVE_KEYS',
  'baseRedaction',
  'CompositePolicy',
  'createAPICallErrorData',
  'createRedaction',
  'DEFAULT_TRANSIENT_RETRY_OPTIONS',
  'DisposableTimeout',
  'fireAndForget',
  'formatDurationHuman',
  'HttpClient',
  'HttpError',
  'HttpStatus',
  'Intl',
  'isAPIError',
  'isHttpError',
  'isSessionExpired',
  'isTransientServerError',
  'LifecycleEmitter',
  'MS_PER_DAY',
  'MS_PER_MINUTE',
  'MS_PER_SECOND',
  'RateLimitError',
  'RateLimitGate',
  'RateLimitPolicy',
  'readHeaders',
  'REDACTED',
  'RegistrySyncError',
  'RetryGuard',
  'SESSION_REFRESH_AHEAD_MS',
  'SessionAPI',
  'setting',
  'syncDevices',
  'SyncManager',
  'Temporal',
  'TransientRetryPolicy',
  'ValidationError',
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

    expect(Object.keys(api).toSorted(byName)).toStrictEqual(EXPECTED)
  })
})
