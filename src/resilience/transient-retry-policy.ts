import type { ResiliencePolicy } from './policy.ts'
import {
  DEFAULT_TRANSIENT_RETRY_OPTIONS,
  isTransientServerError,
  withRetryBackoff,
} from './retry-backoff.ts'

/**
 * Callback surface for per-retry instrumentation.
 */
export interface RetryTelemetry {
  /**
   * Invoked before each scheduled retry attempt.
   */
  readonly onRetry: (attempt: number, error: unknown, delayMs: number) => void
}

/**
 * Exponential-backoff retry for transient server-side failures (502,
 * 503, 504 — see {@link isTransientServerError}). Wraps the attempt
 * with {@link withRetryBackoff} using the caller-provided telemetry
 * hook for every retry tick.
 *
 * This policy only makes sense on idempotent verbs (typically GET):
 * retrying a POST that may have landed server-side is a duplicate
 * write in disguise. The consuming client gates application of this
 * policy accordingly; the policy itself is neutral about method.
 *
 * Ownership: transient 5xx. Non-transient 5xx (e.g., 500) or any
 * other error propagates untouched on the first failure — no retry.
 */
export class TransientRetryPolicy implements ResiliencePolicy {
  readonly #signal: AbortSignal | undefined

  readonly #telemetry: RetryTelemetry

  /**
   * Builds the policy from its telemetry hook and optional abort signal.
   * @param telemetry - Per-retry instrumentation callback.
   * @param signal - Optional signal that cancels a backoff sleep.
   */
  public constructor(telemetry: RetryTelemetry, signal?: AbortSignal) {
    this.#telemetry = telemetry
    this.#signal = signal
  }

  /**
   * Runs the attempt under the shared transient-retry budget.
   * @param attempt - The request attempt to decorate.
   * @returns The attempt's resolved value.
   */
  public async run<T>(attempt: () => Promise<T>): Promise<T> {
    return withRetryBackoff(attempt, {
      ...DEFAULT_TRANSIENT_RETRY_OPTIONS,
      isRetryable: isTransientServerError,
      onRetry: this.#telemetry.onRetry,
      signal: this.#signal,
    })
  }
}
