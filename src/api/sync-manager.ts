import { fireAndForget } from '../fire-and-forget.ts'
import { DisposableTimeout } from '../resilience/index.ts'
import { MS_PER_MINUTE } from '../time-units.ts'
import type { Logger } from './types.ts'

const toIntervalMs = (minutes: number | false): number =>
  minutes === false ? 0 : minutes * MS_PER_MINUTE

/**
 * Manages periodic auto-sync with a configurable interval.
 * Drives the consuming clients' periodic registry refresh.
 */
export class SyncManager implements Disposable {
  #interval: number

  readonly #logger: Logger

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
   * Cancels any pending auto-sync tick.
   */
  public clear(): void {
    this.#timeout.clear()
  }

  /**
   * Schedules the next tick when an interval is armed; the sync runs
   * fire-and-forget so a rejection is logged, never propagated.
   */
  public planNext(): void {
    if (this.#interval > 0) {
      this.#timeout.schedule(() => {
        fireAndForget(this.#syncFunction(), this.#logger, 'Auto-sync failed:')
      }, this.#interval)
    }
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
}
