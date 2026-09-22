import { fireAndForget } from '../fire-and-forget.ts'
import { DisposableTimeout } from '../resilience/index.ts'
import { MS_PER_MINUTE } from '../time-units.ts'
import type { Logger } from './types.ts'

const toIntervalMs = (minutes: number | false): number =>
  minutes === false ? 0 : minutes * MS_PER_MINUTE

/**
 * Manages periodic auto-sync with a configurable interval.
 * Drives the consuming clients' periodic registry refresh.
 *
 * A tick never fires while a hold is open, and never before the quiet
 * period the last release asked for: a mutation in flight would be
 * read back stale by a refresh that overlaps it, and one just landed
 * needs the upstream a moment to settle before a re-read means
 * anything. Holds only DELAY the planned tick — they never advance it.
 * Deadlines are kept on the monotonic clock (`performance.now()`), as
 * every window in this package is: a system-time jump must neither
 * stretch nor collapse the cadence.
 */
export class SyncManager implements Disposable {
  #deadline: number | null = null

  #holds = 0

  #interval: number

  readonly #logger: Logger

  #quietUntil = 0

  readonly #syncFunction: () => Promise<unknown>

  readonly #timeout = new DisposableTimeout()

  /**
   * Builds the manager around the consumer's sync function.
   * @param syncFunction - The sync to fire on each tick.
   * @param logger - Sink for a rejected sync.
   * @param intervalMinutes - Auto-sync cadence; `false` or `0` disables it.
   */
  public constructor(
    syncFunction: () => Promise<unknown>,
    logger: Logger,
    intervalMinutes: number | false = false,
  ) {
    this.#syncFunction = syncFunction
    this.#logger = logger
    this.#interval = toIntervalMs(intervalMinutes)
  }

  /**
   * Cancels any pending auto-sync tick, planned or held. The quiet
   * window survives it on purpose: it is a fact about the upstream
   * (a write is still settling), not about the schedule, so a cadence
   * change or a cycle that clears and re-plans still lands its next
   * tick after the window.
   */
  public clear(): void {
    this.#deadline = null
    this.#timeout.clear()
  }

  /**
   * Opens a hold: the planned tick is parked until every hold is
   * released. Holds nest, one per mutation in flight.
   */
  public hold(): void {
    this.#holds += 1
    this.#timeout.clear()
  }

  /**
   * Schedules the next tick when an interval is armed; the sync runs
   * fire-and-forget so a rejection is logged, never propagated.
   */
  public planNext(): void {
    if (this.#interval <= 0) {
      return
    }
    this.#deadline = performance.now() + this.#interval
    this.#arm()
  }

  /**
   * Closes a hold. When it was the last one, the parked tick is armed
   * again — no earlier than its own deadline, and no earlier than the
   * quiet period from now. A release with no hold open is ignored: it
   * closes nothing, so it settles nothing either.
   * @param quietMs - How long the upstream needs to settle the mutation.
   */
  public release(quietMs: number): void {
    if (this.#holds === 0) {
      return
    }
    this.#holds -= 1
    if (this.#holds !== 0) {
      return
    }

    this.#quietUntil = performance.now() + quietMs
    this.#arm()
  }

  /**
   * Clears the pending timeout on disposal, preventing leaked timers.
   */
  public [Symbol.dispose](): void {
    this.#timeout[Symbol.dispose]()
  }

  /**
   * Updates the cadence and reschedules from now.
   * @param minutes - New interval; `false` or `0` disables the timer.
   */
  public setInterval(minutes: number | false): void {
    this.#interval = toIntervalMs(minutes)
    this.clear()
    this.planNext()
  }

  #arm(): void {
    if (this.#holds > 0 || this.#deadline === null) {
      return
    }
    const now = performance.now()
    const delayMs = Math.max(this.#deadline - now, this.#quietUntil - now, 0)
    this.#timeout.schedule(() => {
      this.#deadline = null
      fireAndForget(this.#syncFunction(), this.#logger, 'Auto-sync failed:')
    }, delayMs)
  }
}
