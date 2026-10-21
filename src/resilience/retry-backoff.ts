import { type HttpError, HttpStatus, isHttpError } from '../http/index.ts'

// HTTP 5xx status codes considered transient (server-side glitches that
// retrying a short moment later can plausibly recover from). 500 is in
// the set since 2.1.0: the policy only ever wraps an idempotent read, and
// the field shows a 500 that is load, not a bug — MELCloud Home answers
// an empty-bodied 500 to a few of the sixteen telemetry reads the Homey
// app fires in the same second at every hour's fifth minute, while the
// same read succeeds for the next device and the next hour (measured
// 2026-10-21, 15:05 CEST, four of sixteen). Retrying a 500 on a read is
// also the default of got, axios-retry and Polly; a deterministic 500
// costs this budget's delays once, then fails as before.
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.BadGateway,
  HttpStatus.GatewayTimeout,
  HttpStatus.InternalServerError,
  HttpStatus.ServiceUnavailable,
])

// Walk the `Error.cause` chain to find a nested HttpError. Guards against
// cycles via a visited set. Used by `isTransientServerError` so that
// wrapped errors (rethrown with the original error attached as
// `new Error(msg, { cause: httpError })`) are still correctly classified.
const findHttpError = (error: unknown): HttpError | undefined => {
  const visited = new Set<object>()
  let current: unknown = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    if (isHttpError(current)) {
      return current
    }
    visited.add(current)
    const { cause } = current as { cause?: unknown }
    current = cause
  }
  return undefined
}

/**
 * Predicate suitable for {@link RetryBackoffOptions.isRetryable}: returns
 * `true` for transient HTTP 5xx status codes (500 / 502 / 503 / 504) including
 * errors wrapped via `Error.cause`. All other inputs return `false`.
 * @param error - The rejection reason thrown by an HTTP call.
 * @returns Whether the error represents a transient server failure.
 */
export const isTransientServerError = (error: unknown): boolean => {
  const httpError = findHttpError(error)
  const status = httpError?.response.status
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status)
}

// Walk the `Error.cause` chain for the first error the predicate
// accepts, cycle-guarded like `findHttpError`.
const findInChain = (
  error: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean => {
  const visited = new Set<object>()
  let current: unknown = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    if (predicate(current)) {
      return true
    }
    visited.add(current)
    const { cause } = current as { cause?: unknown }
    current = cause
  }
  return false
}

// Node's fetch (undici) reports every network-level failure — DNS, a
// connect timeout, a reset, TLS — as `TypeError: fetch failed` with
// the detail on `cause`; the client's own budget fires as a
// `DOMException` named `TimeoutError`. A caller's abort is an
// `AbortError` and stays out: cancelling is not a transient condition.
const isNetworkFailure = (candidate: unknown): boolean =>
  (candidate instanceof TypeError && candidate.message === 'fetch failed') ||
  (candidate instanceof DOMException && candidate.name === 'TimeoutError')

/**
 * Predicate suitable for {@link RetryBackoffOptions.isRetryable}: returns
 * `true` when the transport could not complete the exchange — Node's
 * `TypeError: fetch failed` (DNS, connect timeout, reset, TLS) or the
 * client's own timeout (`DOMException` named `TimeoutError`) — including
 * errors wrapped via `Error.cause`. A caller's abort (`AbortError`) and
 * every HTTP response return `false`. Measured on a Homey (2026-10-22,
 * 01:05): a burst of 23 report reads drew 14 connect timeouts and 9
 * request timeouts while the same burst from a second host passed
 * thirty seconds later — exactly what a retry with backoff recovers.
 * @param error - The rejection reason thrown by an HTTP call.
 * @returns Whether the error represents a transient network failure.
 */
export const isTransientNetworkFailure = (error: unknown): boolean =>
  findInChain(error, isNetworkFailure)

/**
 * The transient set a read is retried on: a transient HTTP status
 * ({@link isTransientServerError}) or a network failure
 * ({@link isTransientNetworkFailure}). Only ever applied to idempotent
 * reads, where re-sending is safe whatever stage the exchange died at.
 * @param error - The rejection reason thrown by an HTTP call.
 * @returns Whether a retry can plausibly succeed.
 */
export const isTransientFailure = (error: unknown): boolean =>
  isTransientServerError(error) || isTransientNetworkFailure(error)

/**
 * Default transient-retry budget shared by every consuming client.
 * Keeping these in one place prevents drift: if we decide to tune the
 * upper bound or jitter ratio, we update a single constant instead of
 * one per consumer.
 */
export const DEFAULT_TRANSIENT_RETRY_OPTIONS: Pick<
  RetryBackoffOptions,
  'initialDelayMs' | 'jitterRatio' | 'maxDelayMs' | 'maxRetries'
> = {
  initialDelayMs: 1000,
  jitterRatio: 0.25,
  maxDelayMs: 16_000,
  maxRetries: 4,
}

/**
 * Options for {@link withRetryBackoff}.
 */
export interface RetryBackoffOptions {
  /**
   * Initial delay in milliseconds before the first retry.
   */
  readonly initialDelayMs: number
  /**
   * Jitter ratio applied to each computed delay (`0..1`).
   */
  readonly jitterRatio: number
  /**
   * Upper bound on the backoff delay.
   */
  readonly maxDelayMs: number
  /**
   * Maximum retry attempts after the initial try (0 disables retries).
   */
  readonly maxRetries: number
  /**
   * Optional abort signal. When fired during a backoff sleep, the
   * pending wait rejects with `signal.reason` and the retry loop exits
   * immediately — so a cancelled caller doesn't pay for an in-flight
   * delay before the next attempt would have started.
   */
  readonly signal?: AbortSignal | undefined
  /**
   * Predicate deciding whether a thrown error is worth retrying.
   */
  readonly isRetryable: (error: unknown) => boolean
  /**
   * Optional hook invoked before the next attempt.
   */
  readonly onRetry?: (attempt: number, error: unknown, delayMs: number) => void
}

// `AbortSignal.reason` is typed `any` and may be a non-Error value
// (the spec lets callers `controller.abort('reason-string')`). Normalise
// to an Error so Promise rejections always satisfy
// `prefer-promise-reject-errors` and downstream `instanceof Error` checks.
const toAbortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason))

// Wrapper over `setTimeout` that surfaces the caller's `signal` as a
// rejection mid-wait. We use the global `setTimeout` (rather than
// `node:timers/promises.setTimeout`, which already accepts `{ signal }`)
// so `vi.useFakeTimers()` keeps mocking the wait — the promises-based
// timer isn't part of the default fake-timers surface in vitest v4.
const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted === true) {
    throw toAbortReason(signal)
  }
  if (signal === undefined) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }
  return new Promise<void>((resolve, reject) => {
    // Detach the abort listener when the timer fires: `{ once: true }`
    // only removes it after an abort, so a long-lived signal (e.g. a
    // host shutdown signal) would otherwise accumulate one listener
    // per backoff sleep for the life of the process.
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(toAbortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// Exponential backoff with symmetric uniform jitter around the base delay.
// The jittered delay is sampled uniformly in
// [base * (1 - ratio), base * (1 + ratio)] and clamped to [0, maxDelayMs].
//
// `Math.random()` is intentional here: retry timing is NOT
// security-sensitive — it's only used to desynchronize concurrent retries
// so a bursty error pattern doesn't resonate into a thundering herd.
// SonarCloud raises S2245 on this line as a VULNERABILITY issue, not a
// reviewable hotspot (the rule is a `former-hotspot` in the
// organization's mode, so `/hotspots/search` shows nothing while the
// gate still fails); the project verdict is Accepted, recorded on the
// issue itself with this rationale.
const computeDelay = (
  attempt: number,
  { initialDelayMs, jitterRatio, maxDelayMs }: RetryBackoffOptions,
): number => {
  const base = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs)
  const jitter = base * jitterRatio * (Math.random() * 2 - 1)
  return Math.max(0, Math.min(base + jitter, maxDelayMs))
}

/**
 * Run `operation`, retrying on errors accepted by `options.isRetryable`.
 *
 * Uses exponential backoff with bounded jitter between attempts. Stops
 * and rethrows once `maxRetries` is exhausted or the error is judged
 * non-retryable. If `options.signal` aborts during a backoff sleep, the
 * loop exits with the signal's reason instead of waiting out the delay.
 * @param operation - The async function to attempt; will be invoked up
 * to `maxRetries + 1` times.
 * @param options - Backoff parameters and retry predicate.
 * @returns The operation's resolved value on first success.
 */
export const withRetryBackoff = async <T>(
  operation: () => Promise<T>,
  options: RetryBackoffOptions,
): Promise<T> => {
  // Recursive shape (over a loop) makes the sequential nature of each
  // attempt structural: every retry strictly awaits the previous
  // attempt's settlement and the backoff delay before the next call.
  const attempt = async (number: number): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (number >= options.maxRetries || !options.isRetryable(error)) {
        throw error
      }
      const delayMs = computeDelay(number, options)
      options.onRetry?.(number + 1, error, delayMs)
      await sleep(delayMs, options.signal)
      return attempt(number + 1)
    }
  }
  return attempt(0)
}
