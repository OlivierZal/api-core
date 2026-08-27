import type { Logger } from '../api/types.ts'
import { RateLimitError } from '../errors/index.ts'
import { HttpStatus, isHttpError } from '../http/index.ts'
import type { ResiliencePolicy } from './policy.ts'
import { type RateLimitGate, formatDurationHuman } from './rate-limit-gate.ts'

/**
 * Rate-limit circuit breaker. Two responsibilities:
 * 1. **Short-circuit** — if the {@link RateLimitGate} is still in a
 *    paused window, throw {@link RateLimitError} **without** letting
 *    the attempt hit the network. Callers see a fast, typed refusal.
 * 2. **Record** — when the attempt comes back with an HTTP 429, arm
 *    the gate from the `Retry-After` header and surface a diagnostic
 *    log before re-raising. Subsequent callers see the paused state
 *    and refuse immediately (see point 1).
 *
 * Ownership: only 429 responses. Any other error (401, 5xx, network)
 * propagates untouched so outer/inner policies can handle it.
 */
export class RateLimitPolicy implements ResiliencePolicy {
  readonly #gate: RateLimitGate

  readonly #logger: Logger

  /**
   * Builds the policy over a shared gate and diagnostic logger.
   * @param gate - Shared rate-limit window tracker.
   * @param logger - Sink for the 429 diagnostic line.
   */
  public constructor(gate: RateLimitGate, logger: Logger) {
    this.#gate = gate
    this.#logger = logger
  }

  /**
   * Refuses fast while the gate is paused, otherwise runs the attempt
   * and records any 429 that comes back.
   * @param attempt - The request attempt to decorate.
   * @returns The attempt's resolved value.
   * @throws {@link RateLimitError} while the gate is paused.
   */
  public async run<T>(attempt: () => Promise<T>): Promise<T> {
    // Read all three fields from one `Temporal.Now.instant()` capture
    // so the error's `retryAfter` and `unblockAt` are mutually
    // consistent — even when the gate re-opens between two separate
    // getter reads.
    const snapshot = this.#gate.snapshot()
    if (snapshot.isPaused) {
      // English-only diagnostic message — consumers that present this
      // to end users should read `retryAfter` / `unblockAt` and format
      // those structured fields with their own i18n stack.
      const { remaining, unblockAt } = snapshot
      throw new RateLimitError(
        `API requests are on hold for ${formatDurationHuman(remaining)}`,
        { retryAfter: remaining, unblockAt },
      )
    }
    try {
      return await attempt()
    } catch (error) {
      this.#recordIfApplicable(error)
      throw error
    }
  }

  #recordIfApplicable(error: unknown): void {
    if (
      !isHttpError(error) ||
      error.response.status !== HttpStatus.TooManyRequests
    ) {
      return
    }
    this.#gate.recordAndLog(this.#logger, error.response.headers['retry-after'])
  }
}
