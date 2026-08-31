import { randomUUID } from 'node:crypto'

import type { LoginCredentials } from '../types/index.ts'
import { setting } from '../decorators/index.ts'
import {
  AuthenticationError,
  AuthenticationThrottledError,
  RegistrySyncError,
} from '../errors/index.ts'
import { fireAndForget } from '../fire-and-forget.ts'
import {
  type HttpClient,
  type HttpResponse,
  isHttpError,
} from '../http/index.ts'
import {
  APICallRequestData,
  APICallResponseData,
  createAPICallErrorData,
  LifecycleEmitter,
} from '../observability/index.ts'
import {
  type ResiliencePolicy,
  AuthRetryPolicy,
  CompositePolicy,
  RateLimitGate,
  RateLimitPolicy,
  RetryGuard,
  TransientRetryPolicy,
} from '../resilience/index.ts'
import { Temporal } from '../temporal.ts'
import { MS_PER_MINUTE } from '../time-units.ts'
import type {
  LifecycleEvents,
  Logger,
  SettingManager,
  SyncCallback,
} from './types.ts'
import { SyncManager } from './sync-manager.ts'

// Cool-down between consecutive auth-retry consumptions on the same
// RetryGuard. Deliberately not configurable: adjusting it is more
// likely to mask bugs than reflect a real product need.
const DEFAULT_AUTH_RETRY_COOLDOWN_MS = 1000

// Automatic re-login backoff after a REJECTED sign-in: an upstream that
// throttles logins aggressively while staying generous with requests on
// an existing session turns a hammered login endpoint into a live
// lockout. Transport failures do not arm it (the normal retry paths
// handle those); an explicit `authenticate()` — the user re-submitting
// credentials — bypasses the gate and resets it on success. The
// deadline persists through the SettingManager so host restarts respect
// it too — field diagnostics showed four rejected sign-ins within 70
// seconds across app restarts, each fresh instance re-attempting
// despite the announced pause.
const LOGIN_BACKOFF_FAILURE_MS = 900_000
const LOGIN_BACKOFF_THROTTLE_MS = 7_200_000

/**
 * How long to hold sign-ins after a throttle rejection. The server's own
 * countdown wins when it announced one — waiting past it is downtime the
 * upstream never asked for, and a field report showed exactly that: a
 * 60-minute lockout answered with a 120-minute pause, leaving a heat
 * pump uncontrollable for the extra hour. The constant stays the cap and
 * the fallback, so an absent or absurd window cannot shorten the pause
 * below what a blind caller would have waited.
 * @param error - The throttle rejection that is arming the backoff.
 * @returns Milliseconds to hold automatic sign-ins.
 */
const throttleBackoffMs = (error: AuthenticationThrottledError): number => {
  const { retryAfter } = error
  if (retryAfter === null) {
    return LOGIN_BACKOFF_THROTTLE_MS
  }
  return Math.min(
    retryAfter.total({ unit: 'milliseconds' }),
    LOGIN_BACKOFF_THROTTLE_MS,
  )
}

const labelLogger = (logger: Logger, label: string): Logger => ({
  error: (...data: unknown[]): void => {
    logger.error(label, ...data)
  },
  log: (...data: unknown[]): void => {
    logger.log(label, ...data)
  },
})

/**
 * User-facing configuration every session-bearing SDK client accepts.
 * A consuming SDK extends it with its own surface (credentials, locale,
 * timezone, transport options, protocol switches).
 * @template TSyncParams - Shape of the consumer-defined parameters the
 * sync notification carries (device ids, type filters…).
 * @category Configuration
 */
export interface SessionAPIConfig<TSyncParams = unknown> {
  /**
   * Optional shutdown signal applied to every outgoing request, and to
   * the transient-retry backoff sleeps.
   */
  readonly abortSignal?: AbortSignal | undefined
  /**
   * Structured-events callbacks invoked around SDK lifecycle moments.
   */
  readonly events?: LifecycleEvents<TSyncParams> | undefined
  /**
   * Custom logger. Defaults to `console`.
   */
  readonly logger?: Logger | undefined
  /**
   * External setting manager for persisting credentials and session data.
   */
  readonly settingManager?: SettingManager | undefined
  /**
   * Auto-sync timer in minutes. `false` disables the timer entirely.
   * Omit to use the subclass default.
   */
  readonly syncIntervalMinutes?: number | false | undefined
}

/**
 * Subclass-internal options injected into the {@link SessionAPI}
 * constructor. Distinct from {@link SessionAPIConfig} (the user-facing
 * surface) — these capture **what the subclass knows** that the user
 * doesn't pick: the built transport, the sync cadence default, the sync
 * runner closure, and the protocol's rate-limit / auth-failure
 * vocabulary.
 * @category Configuration
 */
export interface SessionAPIOptions {
  /**
   * Subclass default for {@link SessionAPIConfig.syncIntervalMinutes}.
   */
  readonly defaultSyncIntervalMinutes: number | false
  /**
   * The transport, ALREADY BUILT by the SDK. Resolving it — deciding
   * whether a host-supplied object is a usable client or a bag of
   * build options — stays in each SDK on purpose: the SDK's own
   * `HttpClient` subclass is what seats its redaction vocabulary, and
   * an `instanceof` check written against the core's base class would
   * accept a bare core client carrying only base redaction where the
   * SDK discards it today.
   */
  readonly transport: HttpClient
  /**
   * Statuses the wire answers an expired or rejected credential with,
   * forwarded to `AuthRetryPolicy`. Defaults to `[401]`; a wire that
   * reports an invalid token as `400` passes both.
   */
  readonly authFailureStatuses?: readonly number[] | undefined
  /**
   * Label prefixed to every log line (e.g. `[Classic]`). Omit it when a
   * single client per host makes disambiguation pointless — the raw
   * logger is then used unwrapped. Clients that emit identically-worded
   * lifecycle logs ("Session resume failed", "Automatic sign-ins
   * paused") from two dialects need it: without one, a host running
   * both cannot tell which account a diagnostics report is about.
   */
  readonly logLabel?: string | undefined
  /**
   * Sliding-window length the rate-limit gate observes. Omit it to
   * build NO rate-limit rung at all — a wire that has never surfaced a
   * 429 gains nothing from the gate.
   */
  readonly rateLimitHours?: number | undefined
  /**
   * Sync runner the auto-timer drives.
   */
  readonly syncCallback: () => Promise<unknown>
}

/**
 * The session lifecycle and request pipeline shared by the SDK API
 * clients: persisted credentials, the login-backoff gate, the
 * logOut-epoch protocol, single-flight session refresh, the resilience
 * pipeline around every request, and the sync-cycle template that keeps
 * the registry and the auto-sync timer honest.
 *
 * Protocol knowledge stays in the subclass, behind the abstract hooks:
 * how to sign in, which headers carry the credential, what "persisted
 * session" means, how the registry is refreshed.
 * @template TSyncParams - Shape of the consumer-defined parameters the
 * sync notification carries.
 * @category API
 */
export abstract class SessionAPI<TSyncParams = unknown> implements Disposable {
  public readonly logger: Logger

  public readonly settingManager?: SettingManager | undefined

  protected readonly abortSignal?: AbortSignal | undefined

  protected readonly events: LifecycleEmitter<TSyncParams>

  /**
   * The rate-limit window tracker, or `undefined` when the subclass
   * built no rate-limit rung. Subclasses that expose an
   * `isRateLimited` surface read it from here.
   */
  protected readonly rateLimitGate: RateLimitGate | undefined

  @setting
  protected accessor expiry = ''

  // Bumped the instant `doAuthenticate` resolves — the one moment at
  // which the SIGN-IN ROUND-TRIP is known accepted, whatever the
  // enforced post-auth sync goes on to do. `resumeSession` compares it
  // across the call, which is what lets it tell an accepted sign-in
  // from a refused one when BOTH leave a live session behind.
  #acceptedSignIns = 0

  // Policy instances are created once in the constructor and reused
  // for every request. Stateless w.r.t. individual calls — the shared
  // state (rate-limit gate, retry guard) lives in the policy's
  // injected dependencies, not in the policy itself.
  readonly #authRetryPolicy: AuthRetryPolicy

  // One event per loss episode: rearmed by any cycle observed
  // authenticated again (including the post-auth sync of a re-login).
  #hasEmittedAuthenticationLost = false

  // Verdict recorded against the STORED credential: the server
  // definitively refused it (a real rejection — never a throttle,
  // whose lockout says nothing about the pair, and never a transport
  // blip) and no sign-in has been accepted since. The stored session
  // deliberately stays — a refusal changes the verdict, never the
  // session — so this record is what lets `#settleSyncCycle` stop
  // serving a session whose account died server-side, where a dialect
  // that never wipes on a refusal keeps `isAuthenticated()` reading
  // `true` indefinitely. In-memory on purpose, like the loss episode
  // marker above: a restart re-witnesses the refusal on its first
  // gated sign-in.
  #isCredentialRefused = false

  // Bumped by every logOut so async work that was in flight when the
  // user signed out (a background resume, a sync cycle) can detect the
  // sign-out on completion and discard what it stored — the explicit
  // sign-out always wins over work it overlapped.
  #logOutEpoch = 0

  readonly #rateLimitPolicy: RateLimitPolicy | undefined

  // Single in-flight refresh handle. Set when the first `ensureSession`
  // call detects an expired session, cleared when the refresh resolves
  // (success or failure). Subsequent concurrent callers await the same
  // promise instead of each triggering their own round-trip — prevents
  // the thundering-herd pattern on token expiry.
  #refreshPromise: Promise<void> | null = null

  // Baseline of `#acceptedSignIns` when the in-flight resume began:
  // lets a caller joining the flight read the verdict the instant the
  // sign-in round-trip is accepted, without awaiting the enforced
  // registry sync still running behind it (see `resumeSession`).
  #resumeAcceptedBefore = 0

  // Single in-flight resume handle — the `#refreshPromise` pattern
  // one lifecycle layer up: concurrent resume paths share ONE sign-in
  // round-trip and read the shared attempt's verdict.
  #resumePromise: Promise<boolean> | null = null

  readonly #retryGuard: RetryGuard

  readonly #syncManager: SyncManager

  readonly #transport: HttpClient

  // Epoch-ms deadline before which automatic re-logins are refused;
  // `''` means no pause. Persisted like the credentials so the gate
  // survives a host restart.
  @setting
  private accessor loginBackoffUntil = ''

  @setting
  private accessor password = ''

  @setting
  private accessor username = ''

  /**
   * Seats the shared session machinery over the user's configuration
   * and the subclass's own knowledge.
   * @param root0 - User-facing configuration.
   * @param root0.abortSignal - Shutdown signal applied to every request.
   * @param root0.events - Lifecycle callbacks.
   * @param root0.logger - Custom logger; defaults to `console`.
   * @param root0.settingManager - External persistence adapter.
   * @param root0.syncIntervalMinutes - Auto-sync cadence override.
   * @param root1 - Subclass-supplied options.
   * @param root1.authFailureStatuses - Statuses that arm the reactive re-auth.
   * @param root1.defaultSyncIntervalMinutes - Subclass sync cadence default.
   * @param root1.logLabel - Optional label prefixed to every log line.
   * @param root1.rateLimitHours - Rate-limit window; omit to build no gate.
   * @param root1.syncCallback - Sync runner the auto-timer drives.
   * @param root1.transport - The already-built HTTP transport.
   */
  protected constructor(
    {
      abortSignal,
      events,
      logger = console,
      settingManager,
      syncIntervalMinutes,
    }: SessionAPIConfig<TSyncParams>,
    {
      authFailureStatuses,
      defaultSyncIntervalMinutes,
      logLabel,
      rateLimitHours,
      syncCallback,
      transport,
    }: SessionAPIOptions,
  ) {
    this.abortSignal = abortSignal
    this.logger =
      logLabel === undefined ? logger : labelLogger(logger, logLabel)
    this.settingManager = settingManager
    this.events = new LifecycleEmitter<TSyncParams>(events, this.logger)
    this.rateLimitGate =
      rateLimitHours === undefined
        ? undefined
        : new RateLimitGate({ hours: rateLimitHours })
    this.#rateLimitPolicy =
      this.rateLimitGate === undefined
        ? undefined
        : new RateLimitPolicy(this.rateLimitGate, this.logger)
    this.#retryGuard = new RetryGuard(DEFAULT_AUTH_RETRY_COOLDOWN_MS)
    this.#transport = transport
    // The RAW logger, not the labelled one: the auto-sync failure line
    // is unlabelled today in the only client that carries a label, and
    // those strings land verbatim in user diagnostic reports.
    this.#syncManager = new SyncManager(
      syncCallback,
      logger,
      syncIntervalMinutes ?? defaultSyncIntervalMinutes,
    )
    this.#authRetryPolicy = new AuthRetryPolicy(
      this.#retryGuard,
      async () => this.reauthenticate(),
      authFailureStatuses,
    )
  }

  /**
   * Subclass hook: clear every persisted session credential (tokens,
   * context keys, expiry — whatever the API persists). Ownership is
   * deliberately narrow: {@link doAuthenticate} wipes on a SUCCESSFUL
   * explicit login just before storing the fresh artifacts (so a failed
   * attempt leaves the previous session untouched), the reactive
   * auth-failure path ({@link reauthenticate}) MAY wipe once the server
   * rejected the credential, and {@link logOut} wipes on an explicit
   * sign-out. Nothing else may clear — in particular the
   * {@link tryReuseSession} probe, where a transient failure is
   * indistinguishable from a rejection and must leave the session
   * untouched.
   *
   * The reactive wipe is a per-dialect verdict, not a rule: melcloud's
   * Home dialect takes it, because a `401` from its BFF IS the access
   * token being refused. Its Classic dialect does not, because a
   * Classic `401` does not name the session — a zone-level
   * `GetSettings` on a shared building answers `401` while the very
   * same context key is serving `/User/ListDevices`, so wiping there
   * would destroy a working session over an authorization verdict
   * about one endpoint.
   */
  protected abstract clearPersistedSession(): void

  /**
   * Subclass hook: empty the device/building registry so a logged-out
   * instance exposes no stale devices. Implemented by syncing the
   * registry collections with empty data (the upsert + prune removes
   * every entry).
   */
  protected abstract clearRegistry(): void

  /**
   * Subclass hook: one protocol-specific sign-in round-trip. On
   * success it must replace the persisted session WHOLESALE — wipe via
   * {@link clearPersistedSession} before storing the fresh artifacts,
   * or overwrite every session key — so nothing from a previous
   * account survives an accepted login. On failure it must leave every
   * store untouched and throw.
   * @param credentials - The pair the server is asked to accept.
   */
  protected abstract doAuthenticate(
    credentials: LoginCredentials,
  ): Promise<void>

  /**
   * Subclass hook: the same registry refresh with failures
   * PROPAGATING, for the enforced post-auth sync. A permanent registry
   * failure must not let a sign-in resolve over an empty registry.
   */
  protected abstract enforceRegistrySync(): Promise<void>

  /**
   * Subclass hook: the credential headers every request carries.
   * @returns The headers merged into each dispatched request.
   */
  protected abstract getAuthHeaders(): Record<string, string>

  /**
   * Subclass hook: whether any persisted session material exists that
   * makes the {@link tryReuseSession} probe worth attempting (e.g. a
   * non-expired token or a refresh token). A `false` skips the probe
   * without issuing a doomed unauthenticated request.
   * @returns `true` when there is something to reuse.
   */
  protected abstract hasPersistedSession(): boolean

  /**
   * Whether a session is currently usable, from local state alone.
   * @returns `true` while the instance holds a usable credential.
   */
  public abstract isAuthenticated(): boolean

  /**
   * Subclass hook: whether the persisted session needs refreshing
   * before the next request. Implementations typically check
   * `isSessionExpired(this.expiry, aheadMs)` with a non-zero
   * `aheadMs` so refresh fires pre-emptively, keeping the re-auth
   * latency off the request's critical path.
   * @returns `true` when {@link ensureSession} should refresh first.
   */
  protected abstract needsSessionRefresh(): boolean

  /**
   * Subclass hook: perform the actual session refresh. Called by
   * {@link ensureSession} when {@link needsSessionRefresh} returns
   * `true`. Errors propagate — the triggering request fails. Use
   * {@link resumeSession} for best-effort behaviour.
   */
  protected abstract performSessionRefresh(): Promise<void>

  /**
   * Subclass hook: refresh the session after a reactive auth failure,
   * before `AuthRetryPolicy` replays the request. Distinct from
   * {@link performSessionRefresh} — this fires *after* the server
   * rejected the current credential, so implementations typically
   * clear persisted tokens first.
   * @returns `true` when authenticated afterwards.
   */
  protected abstract reauthenticate(): Promise<boolean>

  /**
   * Subclass hook: whether the {@link tryReuseSession} probe ended in
   * a reusable state. A `true` promises the {@link initialize}
   * template that the instance is authenticated and the registry has
   * been verified against the server; success semantics differ per
   * API, which is why this stays a hook while the probe skeleton lives
   * in {@link tryReuseSession}.
   * @returns `true` when the probe left a usable session.
   */
  protected abstract reuseSucceeded(): boolean

  /**
   * Subclass hook: refresh the registry BEST-EFFORT. Failures are
   * logged and swallowed — {@link tryReuseSession} depends on it.
   */
  protected abstract syncRegistry(): Promise<void>

  /**
   * Sign in with explicit credentials. The server refuses them in
   * protocol-specific ways, which the subclass's `doAuthenticate` hook
   * normalises into {@link AuthenticationError}. Successful return guarantees the
   * registry reflects server state — the post-auth sync is enforced
   * here so subclasses cannot forget it.
   *
   * Use {@link resumeSession} for a best-effort restore from
   * persisted credentials that logs + swallows errors.
   *
   * Credentials are persisted only once the server accepts them: a
   * rejected attempt leaves the stored pair and any live session
   * untouched (the backoff still arms and the error still surfaces).
   * @param credentials - Explicit username/password.
   * @throws {@link AuthenticationError} when the server refuses the credentials.
   * @throws {@link RegistrySyncError} when the enforced post-auth sync
   * fails — the sync's own failure (a validation rejection, a
   * transport failure, any registry error) rides its `cause`. The
   * credential check happened FIRST, so the session is left signed in
   * and the credentials persisted: this rejection says "signed in, but
   * the registry could not be verified", never "sign-in refused". The
   * dedicated type is what lets callers branch on that difference
   * without re-deriving it from `isAuthenticated()` — a discriminator
   * that misreads a transport blip during an account switch over a
   * pre-existing live session as "signed in, stale list".
   */
  public async authenticate(credentials: LoginCredentials): Promise<void> {
    const epoch = this.#logOutEpoch
    try {
      await this.doAuthenticate(credentials)
    } catch (error) {
      this.#armLoginBackoff(error)
      throw error
    }
    // The sign-in round-trip is ACCEPTED from here on, and nothing
    // below can un-accept it: `#finishLogin` may still reject, but on
    // the registry, never on the credential.
    this.#acceptedSignIns += 1
    // An accepted pair also closes any recorded refusal episode: the
    // stored credential is the one the server just took.
    this.#isCredentialRefused = false
    // Only a server-accepted pair reaches the settings store: writing
    // it earlier would let a mistyped attempt overwrite working
    // credentials. The session store needs no touch here — the
    // `doAuthenticate` contract replaces it wholesale on success.
    this.applyCredentials(credentials.username, credentials.password)
    await this.#finishLogin(epoch)
  }

  /**
   * Cancels any pending auto-sync timer; subsequent `setSyncInterval` or sync calls re-arm it.
   */
  public clearSync(): void {
    this.#syncManager.clear()
  }

  /**
   * Post-construction lifecycle hook. Every subclass `create()`
   * factory must delegate to this method — it is the sole path that
   * guarantees the invariant at instance-creation time: a successful
   * return leaves the registry populated whenever credentials or a
   * persisted session are available.
   *
   * Two-branch template:
   * 1. `tryReuseSession` — if the subclass can reuse a persisted
   *    session (and populate the registry in the process), we are
   *    done.
   * 2. Otherwise, {@link resumeSession} runs — best-effort restore
   *    from persisted credentials. Does nothing (silently) if no
   *    credentials are persisted, so the "no creds + no session"
   *    case falls through to a documented empty state.
   *
   * Callers should check {@link isAuthenticated} after `create()`
   * returns if they need to distinguish "empty state" from "ready".
   */
  public async initialize(): Promise<void> {
    if (await this.tryReuseSession()) {
      return
    }
    if (!(await this.resumeSession()) && this.#hasRecoverableState()) {
      this.#emitAuthenticationLostOnce()
    }
  }

  /**
   * Log out: the inverse of {@link authenticate}. Clears the persisted
   * session, the stored username/password and the automatic-login
   * backoff, stops the auto-sync timer, and empties the registry — so
   * {@link isAuthenticated} reads `false` and no stale devices linger.
   *
   * User-initiated, so unlike a rejected sign-in it neither arms the
   * backoff nor emits `onAuthenticationLost`. A subsequent
   * {@link authenticate} is the only way back in.
   */
  public logOut(): void {
    this.#logOutEpoch += 1
    this.clearPersistedSession()
    this.username = ''
    this.password = ''
    this.#setLoginBackoffUntil(null)
    this.clearSync()
    this.clearRegistry()
  }

  /**
   * Notify any registered `events.onSyncComplete` observer that a
   * sync just landed. Routed through the lifecycle emitter so a
   * misbehaving callback cannot break the caller.
   * @param args - {@link SyncCallback}-shaped payload.
   */
  public async notifySync(
    ...args: Parameters<SyncCallback<TSyncParams>>
  ): Promise<void> {
    await this.events.emitSyncComplete(...args)
  }

  /**
   * Best-effort session restore from persisted credentials.
   *
   * Reads `username`/`password` from the SettingManager and signs
   * in. Unlike {@link authenticate}, failures are **logged and
   * swallowed** — the method never throws. That covers the enforced
   * post-auth sync too: `authenticate` surfaces what
   * `enforceRegistrySync` raises as a {@link RegistrySyncError}, and
   * this method catches it like any other rejection rather than
   * letting a registry failure reach a lifecycle caller. Use it from
   * lifecycle hooks (init, auth retry, `ensureSession`) where a stale
   * or missing persisted credential must not crash the caller.
   *
   * SINGLE-FLIGHT: concurrent calls share one attempt — the lifecycle
   * paths that race at boot (a background `initialize`, the first
   * request's `ensureSession`, a reactive auth failure) collapse onto
   * ONE sign-in round-trip, and every caller's verdict describes that
   * shared attempt. Without the memo, two callers could both pass the
   * login-backoff gate before either refusal armed it, spending two
   * sign-ins against an upstream whose measured throttle threshold was
   * four in seventy seconds.
   *
   * A refusal it swallows is also RECORDED (a definitive rejection
   * only — never a throttle or a transport failure): the stored
   * session stays untouched, but the sync-cycle epilogue stops
   * reading it as signed-in until a sign-in is accepted again.
   *
   * On success, the registry is populated (delegates to
   * {@link authenticate}).
   * @returns `true` when the sign-in round-trip was ACCEPTED —
   * including one whose enforced post-auth sync then failed, because
   * the session it established stands; `false` for "no persisted
   * credentials", "sign-ins are backed off" and "the server refused the
   * credentials" (indistinguishable by the return value alone — check
   * the logger / `isAuthenticated` if the distinction matters).
   */
  public async resumeSession(): Promise<boolean> {
    if (this.#resumePromise !== null) {
      // Joining a flight whose sign-in round-trip is ALREADY accepted
      // (the counter moved past the flight's baseline): the verdict is
      // determined — an accepted sign-in stays a resume whatever its
      // enforced registry sync goes on to do — so answer it without
      // awaiting. The one caller that arrives here DURING that sync is
      // the reactive auth-failure path the sync itself triggered, and
      // awaiting the shared promise would have it wait on its own
      // caller.
      if (this.#acceptedSignIns !== this.#resumeAcceptedBefore) {
        return true
      }
      return this.#resumePromise
    }
    this.#resumeAcceptedBefore = this.#acceptedSignIns
    this.#resumePromise = this.#attemptResumeSession()
    try {
      return await this.#resumePromise
    } finally {
      this.#resumePromise = null
    }
  }

  /**
   * Releases the auto-sync timer and any retry-guard window; the instance must not be reused after disposal.
   */
  public [Symbol.dispose](): void {
    this.#syncManager[Symbol.dispose]()
    this.#retryGuard[Symbol.dispose]()
  }

  /**
   * Reschedules the auto-sync timer.
   *
   * The timer is `unref`'d, so it never keeps the Node event loop alive
   * on its own — auto-sync still fires on cadence whenever the host
   * application has another reason to stay running (HTTP server, other
   * timers, open streams). Apps that must run indefinitely should
   * provide their own keep-alive rather than relying on this timer.
   * @param minutes - Cadence in minutes; pass `false` to disable.
   */
  public setSyncInterval(minutes: number | false): void {
    this.#syncManager.setInterval(minutes)
  }

  /**
   * Run the initial session restore, honoring the configured mode.
   * {@link initialize} never rejects by design (probe and resume
   * failures are swallowed and surfaced through the lifecycle events),
   * so the background variant only needs the fire-and-forget form.
   * @param shouldResumeInBackground - When `true`, the restore runs off
   * the caller's critical path and `create()` resolves immediately.
   */
  public async start(shouldResumeInBackground = false): Promise<void> {
    if (shouldResumeInBackground) {
      fireAndForget(
        this.initialize(),
        this.logger,
        'Background session resume failed:',
      )
      return
    }
    await this.initialize()
  }

  protected applyCredentials(username?: string, password?: string): void {
    if (username !== undefined) {
      this.username = username
    }
    if (password !== undefined) {
      this.password = password
    }
  }

  protected async dispatch<T = unknown>(
    method: string,
    url: string,
    config: Record<string, unknown> = {},
  ): Promise<HttpResponse<T>> {
    const { headers: configHeaders, ...rest } = config
    const requestConfig = {
      ...rest,
      headers: {
        ...(typeof configHeaders === 'object' && configHeaders),
        ...this.getAuthHeaders(),
      },
      method,
      ...(this.abortSignal !== undefined && { signal: this.abortSignal }),
      url,
    }
    this.logger.log(String(new APICallRequestData(requestConfig)))
    const response = await this.#transport.request<T>(requestConfig)
    this.logger.log(String(new APICallResponseData(response, requestConfig)))
    return response
  }

  /**
   * Ensure the persisted session is fresh before letting a request
   * hit the transport. Template method — subclasses do **not**
   * override; they provide {@link needsSessionRefresh} and
   * {@link performSessionRefresh} hooks instead.
   *
   * Two guarantees this method enforces on top of the hooks:
   * 1. **Pre-emptive refresh** — subclass `needsSessionRefresh`
   *    should check expiry with a forward window (`aheadMs`), so the
   *    refresh fires before the token actually expires and no request
   *    ever pays the full re-auth round-trip on its critical path.
   * 2. **Concurrent-refresh deduplication** — the single in-flight
   *    refresh handle prevents the thundering-herd pattern where N
   *    concurrent requests each trigger their own refresh. Only the
   *    first caller kicks off the hook; the rest await the same
   *    promise.
   */
  protected async ensureSession(): Promise<void> {
    if (!this.needsSessionRefresh()) {
      return
    }
    this.#refreshPromise ??= this.#refresh()
    await this.#refreshPromise
  }

  protected logError(error: unknown): void {
    if (isHttpError(error)) {
      this.logger.error(String(createAPICallErrorData(error)))
    }
  }

  protected async request<T = unknown>(
    method: string,
    url: string,
    config: Record<string, unknown> = {},
  ): Promise<HttpResponse<T>> {
    await this.ensureSession()
    const context = {
      correlationId: randomUUID(),
      method: method.toUpperCase(),
      url,
    }
    const policy = this.#buildPolicy(context)
    const attempt = async (): Promise<HttpResponse<T>> => {
      try {
        return await this.dispatch<T>(method, url, config)
      } catch (error) {
        this.logError(error)
        throw error
      }
    }
    return this.#runWithEvents(context, async () => policy.run(attempt))
  }

  /**
   * The heartbeat's guard around {@link runSyncCycle}: a flaky periodic
   * refresh must not crash the host, so the failure is logged and the
   * caller reads an empty list; the next cycle retries.
   *
   * The ENFORCED post-auth sync deliberately does not come through
   * here. A permanent registry failure — a validation rejection, a
   * device type this SDK predates — cannot be cleared by retrying, so
   * swallowing it would let `authenticate()` resolve over an empty
   * registry, which consumers read as "this account has no devices".
   * @template T - The list type the cycle resolves to.
   * @param cycle - The registry cycle to run best-effort.
   * @returns The fetched entries, or an empty array on failure.
   */
  protected async runBestEffortSyncCycle<T extends readonly unknown[]>(
    cycle: () => Promise<T>,
  ): Promise<T | []> {
    try {
      return await cycle()
    } catch (error) {
      this.logger.error('Failed to fetch devices:', error)
      return []
    }
  }

  /**
   * Template for the registry-refresh heartbeat: pause the auto-sync
   * timer, run the subclass work, and always settle the cycle —
   * rescheduling the next sync, re-applying a raced sign-out, or
   * surfacing a lost session.
   * @template T - Whatever the subclass work resolves to.
   * @param work - Subclass closure that fetches and syncs the registry.
   * @returns The work's resolved value.
   * @throws Whatever `work` raises — see
   *   {@link runBestEffortSyncCycle} for the swallowing variant.
   */
  protected async runSyncCycle<T>(work: () => Promise<T>): Promise<T> {
    const epoch = this.#logOutEpoch
    this.clearSync()
    try {
      return await work()
    } finally {
      this.#settleSyncCycle(epoch)
    }
  }

  /**
   * Try to reuse a persisted session without a full re-authentication:
   * skip when nothing is persisted, otherwise run one registry sync
   * and let {@link reuseSucceeded} judge the outcome. Returning
   * `false` falls through to a full {@link authenticate}.
   *
   * The probe is strictly non-destructive: {@link syncRegistry}
   * swallows transient failures, which are indistinguishable here from
   * a credential rejection, so clearing persisted state from this path
   * would destroy valid sessions on a boot-time network blip. Clearing
   * is owned by {@link clearPersistedSession}'s callers only.
   * @returns `true` on reuse + registry populated; `false` otherwise.
   */
  protected async tryReuseSession(): Promise<boolean> {
    if (!this.hasPersistedSession()) {
      return false
    }
    await this.syncRegistry()
    return this.reuseSucceeded()
  }

  #armLoginBackoff(error: unknown): void {
    if (!(error instanceof AuthenticationError)) {
      // A transport failure is not a rejected login: the normal retry
      // paths own those, and pausing sign-ins would mask a mere blip.
      return
    }
    const backoffMs =
      error instanceof AuthenticationThrottledError
        ? throttleBackoffMs(error)
        : LOGIN_BACKOFF_FAILURE_MS
    this.#setLoginBackoffUntil(
      Temporal.Now.instant().epochMilliseconds + backoffMs,
    )
    this.logger.error(
      `Automatic sign-ins paused for ${String(Math.round(backoffMs / MS_PER_MINUTE))} minutes after a rejected login`,
    )
  }

  // The resume attempt proper — `resumeSession` memoizes it so that
  // concurrent lifecycle paths share one sign-in round-trip instead of
  // racing the login-backoff gate.
  async #attemptResumeSession(): Promise<boolean> {
    if (this.#isLoginBackedOff()) {
      return false
    }
    const credentials = this.#resolvePersistedCredentials()
    if (credentials === null) {
      return false
    }
    const acceptedBefore = this.#acceptedSignIns
    try {
      await this.authenticate(credentials)
      return true
    } catch (error) {
      return this.#reportResumeFailure(error, acceptedBefore)
    }
  }

  /**
   * Build the per-request resilience pipeline. Order matters — outer
   * policies see the attempt first: the optional rate-limit rung
   * guards the entry point, auth-retry handles credential failures
   * after the inner retries give up, and the optional transient retry
   * (GET-only) is the innermost wrapper around the raw
   * {@link dispatch}.
   * @param context - Per-request correlation context used by the
   * transient-retry telemetry when it fires.
   * @param context.correlationId - UUID for cross-emission linkage.
   * @param context.method - HTTP method (uppercased) of the request.
   * @param context.url - URL of the request being dispatched.
   * @returns The composite policy ready to run the attempt.
   */
  #buildPolicy(context: {
    correlationId: string
    method: string
    url: string
  }): ResiliencePolicy {
    const policies: ResiliencePolicy[] = []
    if (this.#rateLimitPolicy !== undefined) {
      policies.push(this.#rateLimitPolicy)
    }
    policies.push(this.#authRetryPolicy)
    if (context.method === 'GET') {
      policies.push(
        new TransientRetryPolicy(
          {
            onRetry: (
              retryAttempt: number,
              error: unknown,
              delayMs: number,
            ): void => {
              this.logger.log(
                `Transient server error on ${context.url}: retry ${String(retryAttempt)} in ${String(delayMs)} ms`,
              )
              this.events.emitRetry({
                ...context,
                attempt: retryAttempt,
                delayMs,
                error,
              })
            },
          },
          this.abortSignal,
        ),
      )
    }
    return new CompositePolicy(policies)
  }

  #emitAuthenticationLostOnce(): void {
    if (this.#hasEmittedAuthenticationLost) {
      return
    }

    this.#hasEmittedAuthenticationLost = true
    this.events.emitAuthenticationLost()
  }

  // Post-`doAuthenticate` epilogue, split on the logOut epoch: a
  // logOut that landed while the sign-in round-trip was in flight
  // (e.g. the user signed out during a background resume) wins —
  // discard what the login just stored and stay signed out. Otherwise
  // clear the backoff gate and run the enforced post-auth sync.
  async #finishLogin(epoch: number): Promise<void> {
    if (this.#logOutEpoch !== epoch) {
      this.clearPersistedSession()
      this.username = ''
      this.password = ''
      return
    }
    this.#setLoginBackoffUntil(null)
    try {
      await this.enforceRegistrySync()
    } catch (error) {
      // The credential check succeeded FIRST, so this rejection must
      // stay distinguishable BY TYPE from a refused sign-in — the
      // wrap is what spares consumers the judge-by-the-session
      // fallback (`isAuthenticated()`), whose false positive is a
      // transport blip during an account switch over a pre-existing
      // live session.
      throw new RegistrySyncError(
        'Signed in, but the registry could not be verified',
        { cause: error },
      )
    }
  }

  // A loss is only a loss when there was something to restore — a
  // persisted session or persisted credentials. Probing an API that was
  // never configured must neither notify nor look like an expiry.
  #hasRecoverableState(): boolean {
    return (
      this.hasPersistedSession() || this.#resolvePersistedCredentials() !== null
    )
  }

  // A corrupt persisted value reads as "no pause" — never lock the
  // user out on bad data.
  #isLoginBackedOff(): boolean {
    const raw = this.loginBackoffUntil
    if (raw === '') {
      return false
    }
    const until = Number(raw)
    return (
      Number.isFinite(until) && Temporal.Now.instant().epochMilliseconds < until
    )
  }

  // The composite verdict every loss-surfacing path consults: a
  // session only counts as signed-in while no definitive refusal
  // stands against the stored credential. `isAuthenticated()` alone
  // cannot say that on a dialect whose refusal deliberately leaves the
  // session material in place — the session answers "a session
  // stands", never "the credential does".
  #isSessionServable(): boolean {
    return this.isAuthenticated() && !this.#isCredentialRefused
  }

  // A live session marks any earlier loss episode as recovered —
  // announced once per episode, so the two events always alternate.
  #markLossRecovered(): void {
    if (!this.#hasEmittedAuthenticationLost) {
      return
    }

    this.#hasEmittedAuthenticationLost = false
    this.events.emitAuthenticationRestored()
  }

  // The memoized body behind `ensureSession`'s single-flight handle.
  // The clean-up is a `try`/`finally` rather than a `.finally()` on the
  // hook's promise: the handle must be released exactly when the shared
  // refresh settles, and the statement form keeps the family's
  // no-`.finally()` rule intact.
  async #refresh(): Promise<void> {
    try {
      await this.performSessionRefresh()
    } finally {
      this.#refreshPromise = null
    }
  }

  // The verdict `resumeSession` puts on a rejection it swallowed:
  // judged by the SIGN-IN ROUND-TRIP — not by the throw, and not by
  // the session either, because BOTH failures can leave a live session
  // standing and only the round-trip separates them.
  // - ACCEPTED, then the enforced registry sync threw: the session was
  //   established, so a `false` here would have `initialize()` emit a
  //   spurious `onAuthenticationLost`, prompting the user to sign in
  //   again over credentials that had just worked.
  // - REFUSED, over a session that predates the attempt: nothing was
  //   refreshed, so a `true` here hands the caller the credential the
  //   server has just rejected. When a dialect wires the reactive
  //   auth-failure path (`reauthenticate`) through this method, the
  //   `AuthRetryPolicy` replay then spends its one guarded round-trip
  //   re-sending the very credential the server refused.
  #reportResumeFailure(error: unknown, acceptedBefore: number): boolean {
    this.logger.error('Session resume failed:', error)
    if (this.#acceptedSignIns !== acceptedBefore) {
      return true
    }
    // A DEFINITIVE refusal — not a throttle, whose lockout says
    // nothing about the pair, and not a transport blip — is recorded
    // as a verdict on the stored credential. The record is what lets
    // the loss-surfacing paths see a dead credential behind a session
    // the refusal deliberately did not clear; the next ACCEPTED
    // sign-in lifts it.
    if (
      error instanceof AuthenticationError &&
      !(error instanceof AuthenticationThrottledError)
    ) {
      this.#isCredentialRefused = true
    }
    return false
  }

  #resolvePersistedCredentials(): LoginCredentials | null {
    const { password, username } = this
    if (username === '' || password === '') {
      return null
    }
    return { password, username }
  }

  // The duration clock is `performance.now()`, not the wall clock: a
  // system-clock adjustment mid-request would otherwise report a
  // negative or wildly inflated `durationMs` to every observer. Same
  // verdict, same reason as `RetryGuard`'s window.
  async #runWithEvents<T>(
    context: { correlationId: string; method: string; url: string },
    runner: () => Promise<HttpResponse<T>>,
  ): Promise<HttpResponse<T>> {
    const startedAt = performance.now()
    this.events.emitStart(context)
    try {
      const response = await runner()
      this.events.emitComplete({
        ...context,
        durationMs: performance.now() - startedAt,
        status: response.status,
      })
      return response
    } catch (error) {
      this.events.emitError({
        ...context,
        durationMs: performance.now() - startedAt,
        error,
      })
      throw error
    }
  }

  // `''` is the cleared sentinel: the `@setting` accessor persists the
  // value and deletes the key outright when the host delegates `unset`.
  #setLoginBackoffUntil(until: number | null): void {
    this.loginBackoffUntil = until === null ? '' : String(until)
  }

  // Sync-cycle epilogue, split on the logOut epoch. A logOut that
  // landed while the cycle was in flight: its request completed with
  // the pre-sign-out session and repopulated the registry — re-run the
  // wipe so the sign-out sticks, and leave the timer disarmed.
  // Unauthenticated with nothing to recover from (e.g. a settings page
  // probing a never-configured API) stays silent AND disarmed. The
  // signed-in read is the RECORDED verdict, not the bare session: a
  // stored credential the server has definitively refused falls
  // through to the loss branch even while a stale session keeps
  // `isAuthenticated()` reading `true`.
  #settleSyncCycle(epoch: number): void {
    if (this.#logOutEpoch !== epoch) {
      this.clearPersistedSession()
      this.clearRegistry()
      return
    }
    if (this.#isSessionServable()) {
      this.#markLossRecovered()
      this.#syncManager.planNext()
      return
    }
    if (this.#hasRecoverableState()) {
      // Rescheduling would hammer the account with a doomed sign-in
      // every cycle: stay disarmed and surface the loss instead — a
      // successful authenticate() re-arms the sync through its
      // enforced post-auth registry sync.
      this.#emitAuthenticationLostOnce()
    }
  }
}
