import { type HttpError, HttpStatus, isHttpError } from '../http/index.ts'
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
/**
 * What a policy owns as an auth failure: the statuses, optionally
 * narrowed by the response itself.
 */
export interface AuthFailureVocabulary {
  /**
   * Narrows a listed status by the response, for a wire that answers
   * several failures with one status — Gizwits answers an invalid token
   * and a server error alike with `400`.
   */
  readonly refine?: ((error: HttpError) => boolean) | undefined
  /**
   * Auth-failure statuses; defaults to `[401]`.
   */
  readonly statuses?: readonly number[] | undefined
}

const isStatusList = (
  vocabulary: AuthFailureVocabulary | readonly number[],
): vocabulary is readonly number[] => Array.isArray(vocabulary)

export class AuthRetryPolicy implements ResiliencePolicy {
  readonly #guard: RetryGuard

  readonly #reauthenticate: () => Promise<boolean>

  readonly #refine: ((error: HttpError) => boolean) | undefined

  readonly #statuses: readonly number[]

  /**
   * Builds the policy from its guard, reauth hook and status vocabulary.
   * @param guard - Shared retry-budget limiter.
   * @param reauthenticate - Hook that refreshes the session; resolves `true` on success.
   * @param vocabulary - The auth-failure statuses that trigger the retry
   * (`[401]` by default), or the statuses with a refinement that narrows
   * them by the response itself.
   */
  public constructor(
    guard: RetryGuard,
    reauthenticate: () => Promise<boolean>,
    vocabulary: AuthFailureVocabulary | readonly number[] = [
      HttpStatus.Unauthorized,
    ],
  ) {
    const { refine, statuses = [HttpStatus.Unauthorized] } = isStatusList(
      vocabulary,
    )
      ? { refine: undefined, statuses: vocabulary }
      : vocabulary
    this.#guard = guard
    this.#refine = refine
    this.#reauthenticate = reauthenticate
    this.#statuses = statuses
  }

  /**
   * Whether a rejection is an auth failure this policy owns: an
   * `HttpError` whose status is in the injected vocabulary. The one
   * read of that vocabulary outside the retry itself — `SessionAPI`'s
   * sign-in normalization consults it so the statuses are spelled once
   * per protocol.
   * @param error - The rejection to inspect.
   * @returns `true` for an owned auth failure, narrowing it.
   */
  public isAuthFailure(error: unknown): error is HttpError {
    return (
      isHttpError(error) &&
      this.#statuses.includes(error.response.status) &&
      (this.#refine?.(error) ?? true)
    )
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
      if (!this.#shouldRetry(error) || !(await this.#reauthenticate())) {
        throw error
      }
      return attempt()
    }
  }

  #shouldRetry(error: unknown): boolean {
    return this.isAuthFailure(error) && this.#guard.tryConsume()
  }
}
