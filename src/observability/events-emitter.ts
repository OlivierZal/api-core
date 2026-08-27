import type {
  LifecycleEvents,
  Logger,
  RequestCompleteEvent,
  RequestErrorEvent,
  RequestRetryEvent,
  RequestStartEvent,
  SyncCallback,
} from '../api/types.ts'
import { fireAndForget } from '../fire-and-forget.ts'

/**
 * Thin wrapper around a {@link LifecycleEvents} bundle that swallows
 * any exceptions raised by consumer callbacks and logs them at error
 * level. A misbehaving observer must never be able to break the
 * request or sync flow — observability is a side concern, never a
 * blocker.
 * @template TSyncParams - Shape of the consumer-defined parameters the
 * sync notification carries.
 */
export class LifecycleEmitter<TSyncParams = unknown> {
  readonly #events?: LifecycleEvents<TSyncParams> | undefined

  readonly #logger: Logger

  /**
   * Wraps a consumer's callback bundle behind the non-throwing contract.
   * @param events - Optional lifecycle callbacks supplied by the consumer.
   * @param logger - Sink for the exceptions the callbacks raise.
   */
  public constructor(
    events: LifecycleEvents<TSyncParams> | undefined,
    logger: Logger,
  ) {
    this.#events = events
    this.#logger = logger
  }

  /**
   * Notifies `onAuthenticationLost` that the session is definitively lost.
   */
  public emitAuthenticationLost(): void {
    this.#safeInvoke('onAuthenticationLost', () =>
      this.#events?.onAuthenticationLost?.(),
    )
  }

  /**
   * Notifies `onAuthenticationRestored` that the session recovered.
   */
  public emitAuthenticationRestored(): void {
    this.#safeInvoke('onAuthenticationRestored', () =>
      this.#events?.onAuthenticationRestored?.(),
    )
  }

  /**
   * Notifies `onRequestComplete` of a successful response.
   * @param event - Completion event carrying status and duration.
   */
  public emitComplete(event: RequestCompleteEvent): void {
    this.#safeInvoke('onRequestComplete', () =>
      this.#events?.onRequestComplete?.(event),
    )
  }

  /**
   * Notifies `onRequestError` of a permanently-failed request.
   * @param event - Error event carrying the terminal error and duration.
   */
  public emitError(event: RequestErrorEvent): void {
    this.#safeInvoke('onRequestError', () =>
      this.#events?.onRequestError?.(event),
    )
  }

  /**
   * Notifies `onRequestRetry` of a scheduled retry attempt.
   * @param event - Retry event carrying the attempt number and delay.
   */
  public emitRetry(event: RequestRetryEvent): void {
    this.#safeInvoke('onRequestRetry', () =>
      this.#events?.onRequestRetry?.(event),
    )
  }

  /**
   * Notifies `onRequestStart` that a request was dispatched.
   * @param event - Start event carrying the correlation id, method and URL.
   */
  public emitStart(event: RequestStartEvent): void {
    this.#safeInvoke('onRequestStart', () =>
      this.#events?.onRequestStart?.(event),
    )
  }

  /**
   * Notifies `onSyncComplete` that a sync landed. Awaited (unlike the
   * `emit*` family): a consumer's sync decorator awaits the
   * notification so a decorated mutation resolves only after the
   * observer has run. The non-throwing contract is the same — failures
   * route through the shared reporter.
   * @param args - Consumer-defined sync parameters, forwarded verbatim.
   * @returns Resolves once the observer settled (or was absent).
   */
  public async emitSyncComplete(
    ...args: Parameters<SyncCallback<TSyncParams>>
  ): Promise<void> {
    const callback = this.#events?.onSyncComplete
    if (callback === undefined) {
      return
    }
    try {
      await callback(...args)
    } catch (error) {
      this.#reportFailure('onSyncComplete', error)
    }
  }

  #reportFailure(callback: string, error: unknown): void {
    this.#logger.error(
      `LifecycleEvents.${callback} callback threw — ignoring`,
      error,
    )
  }

  #safeInvoke(callback: string, invoke: () => unknown): void {
    // Catch BOTH synchronous throws and async rejections. The
    // `onRequest*` signatures are typed `(event) => void`, but TS's
    // structural assignability lets callers pass `async () => …`
    // (a `() => Promise<void>` is assignable to `() => void`).
    // `invoke` is widened to `() => unknown` so we can detect when
    // the runtime return is a Promise and chain `.catch` onto it —
    // otherwise a rejected promise escapes as an unhandled rejection
    // and breaks the "non-throwing observer" contract this emitter
    // is meant to enforce.
    try {
      this.#watchRejection(callback, invoke())
    } catch (error) {
      this.#reportFailure(callback, error)
    }
  }

  #watchRejection(callback: string, result: unknown): void {
    if (result instanceof Promise) {
      fireAndForget(
        result,
        this.#logger,
        `LifecycleEvents.${callback} callback rejected — ignoring`,
      )
    }
  }
}
