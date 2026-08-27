/**
 * One-shot retry budget limiter.
 *
 * Allows at most one retry per configured window. `tryConsume()`
 * returns `true` when the budget is available (and opens a new
 * window), `false` otherwise. Used by API clients to cap reactive
 * re-authentication attempts on auth-failure responses and prevent
 * tight retry loops.
 */
export class RetryGuard implements Disposable {
  readonly #delay: number

  // Monotonic-ms deadline of the current window; consuming before it is
  // refused. A plain deadline needs no timer to expire, and the
  // monotonic clock keeps the window immune to system-clock
  // adjustments — a wall-clock deadline would stretch it across a
  // backwards jump.
  #until = 0

  /**
   * Builds a guard whose budget refills `delayMs` after a consume.
   * @param delayMs - Width of the refusal window in milliseconds.
   */
  public constructor(delayMs: number) {
    this.#delay = delayMs
  }

  /**
   * Cancel the current retry window on disposal, so a disposed guard
   * never withholds a budget behind a dead client.
   */
  public [Symbol.dispose](): void {
    this.#until = 0
  }

  /**
   * Attempt to consume the retry budget.
   * @returns `true` if the caller may proceed with a retry, `false` if the
   *   budget is exhausted for the current window.
   */
  public tryConsume(): boolean {
    const now = performance.now()
    if (now < this.#until) {
      return false
    }
    this.#until = now + this.#delay
    return true
  }
}
