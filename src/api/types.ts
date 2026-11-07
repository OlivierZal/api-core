/**
 * Callback bundle invoked around SDK lifecycle moments. All callbacks
 * are optional and non-throwing — the SDK ignores any exceptions they
 * raise so a buggy observer cannot break the request flow.
 *
 * Two scopes coexist here:
 * - **Per-request** (`onRequest*`) — fires for every outgoing HTTP call.
 * - **Per-sync** (`onSyncComplete`) — fires after each sync trigger
 *   (auto-timer OR a sync-decorated mutation), once the downstream
 *   device state has been refreshed.
 * @template TSyncParams - Shape of the consumer-defined parameters the
 * sync notification carries (device ids, type filters…).
 * @category Configuration
 */
export interface LifecycleEvents<TSyncParams = unknown> {
  /**
   * Fires when the session is definitively lost — when nothing
   * automatic can end the loss: the stored credential was refused (by a
   * resume at boot, a deferred retry or the reactive re-auth), or a
   * persisted session died with no credential to sign back in with.
   * The user has to act, typically by signing in again. A TRANSIENT
   * failure — a transport blip, a server error — fires nothing: the
   * resume is retried every minute until it succeeds (2.4.0). On a
   * definitive loss the auto-sync disarms (rescheduling would hammer
   * the account with a doomed sign-in every cycle); a successful
   * `authenticate()` re-arms it. Fires once per loss episode.
   */
  readonly onAuthenticationLost?: (() => void) | undefined
  /**
   * Fires when a sync cycle ends authenticated after an
   * `onAuthenticationLost` episode — after the accepted sign-in that
   * ends it, since a refused credential is never retried automatically.
   * Fires once per loss episode, so the two events always alternate; a
   * transient failure, having fired no loss, fires no recovery either.
   */
  readonly onAuthenticationRestored?: (() => void) | undefined
  /**
   * Invoked after a successful HTTP response is received.
   */
  readonly onRequestComplete?:
    ((event: RequestCompleteEvent) => void) | undefined
  /**
   * Invoked when a request fails permanently (retries exhausted).
   */
  readonly onRequestError?: ((event: RequestErrorEvent) => void) | undefined
  /**
   * Invoked before each backoff-scheduled retry attempt.
   */
  readonly onRequestRetry?: ((event: RequestRetryEvent) => void) | undefined
  /**
   * Invoked when a request is dispatched for the first time.
   */
  readonly onRequestStart?: ((event: RequestStartEvent) => void) | undefined
  /**
   * Invoked after each sync trigger (auto-timer or a sync-decorated
   * mutation), with the consumer-defined scoping parameters.
   */
  readonly onSyncComplete?: SyncCallback<TSyncParams> | undefined
}

/**
 * Logger interface for API call tracing.
 * @category Configuration
 */
export interface Logger {
  /**
   * Log error messages.
   */
  readonly error: Console['error']
  /**
   * Log informational messages.
   */
  readonly log: Console['log']
}

/**
 * Emitted when a request (possibly after retries) completes successfully.
 * @category Configuration
 */
export interface RequestCompleteEvent extends RequestLifecycleContext {
  /**
   * Elapsed time in milliseconds, including any retry delays.
   */
  readonly durationMs: number
  /**
   * Final HTTP status code returned by the upstream server.
   */
  readonly status: number
}

/**
 * Emitted when a request ultimately fails after exhausting its retries.
 * @category Configuration
 */
export interface RequestErrorEvent extends RequestLifecycleContext {
  /**
   * Elapsed time in milliseconds, including any retry delays.
   */
  readonly durationMs: number
  /**
   * The terminal error thrown by the request.
   */
  readonly error: unknown
}

/**
 * Identifies a single logical request across its lifecycle events.
 * Generated client-side via `crypto.randomUUID()` when each request
 * starts, so consumers can correlate a `onRequestStart` with its
 * eventual `onRequestComplete` or `onRequestError` — including across
 * retry attempts, which share the same `correlationId`.
 * @category Configuration
 */
export interface RequestLifecycleContext {
  /**
   * Unique request identifier (UUID v4).
   */
  readonly correlationId: string
  /**
   * HTTP method, uppercase.
   */
  readonly method: string
  /**
   * Request URL (possibly relative to the client's baseURL).
   */
  readonly url: string
}

/**
 * Emitted each time a retry attempt is scheduled.
 * @category Configuration
 */
export interface RequestRetryEvent extends RequestLifecycleContext {
  /**
   * 1-based retry attempt number (1 = first retry, not the initial try).
   */
  readonly attempt: number
  /**
   * Backoff delay in milliseconds before this retry fires.
   */
  readonly delayMs: number
  /**
   * The error that triggered the retry.
   */
  readonly error: unknown
}

/**
 * Emitted at the start of a request, before any retry attempts.
 * @category Configuration
 */
export type RequestStartEvent = RequestLifecycleContext

/**
 * External storage adapter for persisting API session settings.
 * @category Configuration
 */
export interface SettingManager {
  /**
   * Retrieve a setting value by key. Returns the stored value, or `null`/`undefined` if absent.
   */
  readonly get: (key: string) => string | null | undefined
  /**
   * Store a setting value by key.
   */
  readonly set: (key: string, value: string) => void
  /**
   * Delete a setting key. Optional: when a host does not provide it, the
   * SDK clears by storing an empty string instead, which reads back as
   * absent all the same.
   */
  readonly unset?: (key: string) => void
}

/**
 * Callback invoked after sync operations, with consumer-defined
 * scoping parameters (device ids, type filters…).
 * @template TParams - Shape of the optional parameter object.
 * @category Configuration
 */
export type SyncCallback<TParams = unknown> = (
  params?: TParams,
) => Promise<void>
