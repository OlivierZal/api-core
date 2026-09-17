import { MS_PER_MINUTE } from '../time-units.ts'

const REMINDER_INTERVAL_MINUTES = 5

/**
 * How long an unchanged failure stays silent before the log repeats it.
 * Five minutes is the cadence at which one line per failed cycle was
 * once accepted, and short enough that a diagnostic report's tail still
 * carries a running failure.
 */
export const FAILURE_REMINDER_INTERVAL_MS: number =
  REMINDER_INTERVAL_MINUTES * MS_PER_MINUTE

interface Streak {
  readonly failures: number
  readonly reason: string
  readonly remindedAt: number
}

/**
 * Failure streaks per SUBJECT — an endpoint, the registry cycle — so a
 * repeated failure is one event in the log rather than one entry per
 * attempt.
 *
 * A host polls on a cadence it chooses: heatzy-api reads every device
 * every five seconds, which turned one stuck device into 17,280 error
 * entries a day and drowned the diagnostic reports users paste into
 * issues. A streak is therefore reported when it opens, when its reason
 * changes, and at most every {@link FAILURE_REMINDER_INTERVAL_MS} while
 * it stands — a window, not a count, since the count means nothing
 * without the caller's cadence — then closed when the subject succeeds
 * again.
 *
 * Windows ride the monotonic clock (`performance.now()`), as every
 * window in this package does: a system-time jump must neither stretch
 * nor collapse them.
 */
export class FailureStreaks {
  readonly #streaks = new Map<string, Streak>()

  /**
   * Forget every streak — a sign-out, a disposal: what follows is a new
   * episode, and its first failure is reported in full.
   */
  public clear(): void {
    this.#streaks.clear()
  }

  /**
   * Close a subject's streak, if it had one.
   * @param subject - The endpoint or task that succeeded.
   * @returns The failures the streak swallowed, or `null` when none was
   * open — the caller writes a recovery line only for the former.
   */
  public close(subject: string): number | null {
    const streak = this.#streaks.get(subject)
    if (streak === undefined) {
      return null
    }
    this.#streaks.delete(subject)
    return streak.failures
  }

  /**
   * Record a failure against its subject.
   * @param subject - The endpoint or task that failed.
   * @param reason - The failure's identity. Keep it STABLE across
   * repeats: a reason carrying a value that changes between attempts
   * reopens the streak on every one of them.
   * @returns `true` when this failure must be written: the streak is
   * new, its reason changed, or the reminder window has elapsed.
   */
  public shouldReport(subject: string, reason: string): boolean {
    const now = performance.now()
    const streak = this.#streaks.get(subject)
    if (streak?.reason !== reason) {
      this.#streaks.set(subject, { failures: 1, reason, remindedAt: now })
      return true
    }
    const isDue = now - streak.remindedAt >= FAILURE_REMINDER_INTERVAL_MS
    this.#streaks.set(subject, {
      failures: streak.failures + 1,
      reason,
      remindedAt: isDue ? now : streak.remindedAt,
    })
    return isDue
  }
}
