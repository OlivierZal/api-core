import { HttpStatus, isHttpError } from '../http/index.ts'
import type { ResiliencePolicy } from './policy.ts'
import type { RetryGuard } from './retry-guard.ts'

/**
 * Reactive authentication retry. On an auth-failure status:
 * 1. **Gate** the retry via a shared {@link RetryGuard} — only one
 *    retry per guard window, so a repeatedly-rejected credential
 *    doesn't spin forever.
 * 2. **Reauthenticate** through the injected hook. The hook returns
 *    `true` if the session was successfully refreshed (token
 *    exchange or full `resumeSession`) and `false` if it failed.
 * 3. **Replay** the original attempt exactly once on a successful
 *    reauth. Any other outcome re-throws the original error.
 *
 * Ownership: only the injected auth-failure statuses (`401` by
 * default; a wire that reports an expired token as `400` passes both).
 * Other HTTP errors, network errors, and anything not from `HttpError`
 * propagate unchanged so inner / outer policies can handle them in
 * isolation.
 */
export class AuthRetryPolicy implements ResiliencePolicy {
  readonly #guard: RetryGuard

  readonly #reauthenticate: () => Promise<boolean>

  readonly #statuses: readonly number[]

  /**
   * Builds the policy from its guard, reauth hook and status vocabulary.
   * @param guard - Shared retry-budget limiter.
   * @param reauthenticate - Hook that refreshes the session; resolves `true` on success.
   * @param statuses - Auth-failure statuses that trigger the retry; defaults to `[401]`.
   */
  public constructor(
    guard: RetryGuard,
    reauthenticate: () => Promise<boolean>,
    statuses: readonly number[] = [HttpStatus.Unauthorized],
  ) {
    this.#guard = guard
    this.#reauthenticate = reauthenticate
    this.#statuses = statuses
  }

  /**
   * Runs the attempt, replaying it once after a successful reauth.
   * @param attempt - The request attempt to decorate.
   * @returns The attempt's resolved value.
   * @throws {@link HttpError} The original error, when the guard
   * refuses the window or the reauth hook fails (anything not an owned
   * auth failure propagates unchanged).
   */
  public async run<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt()
    } catch (error) {
      if (!this.#shouldRetry(error)) {
        throw error
      }
      if (!(await this.#reauthenticate())) {
        throw error
      }
      return attempt()
    }
  }

  #shouldRetry(error: unknown): boolean {
    return (
      isHttpError(error) &&
      this.#statuses.includes(error.response.status) &&
      this.#guard.tryConsume()
    )
  }
}
