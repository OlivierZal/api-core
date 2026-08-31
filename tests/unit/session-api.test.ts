import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { SettingManager } from '../../src/api/types.ts'
import type { LoginCredentials } from '../../src/types/index.ts'
import {
  type SessionAPIConfig,
  type SessionAPIOptions,
  SessionAPI,
} from '../../src/api/session-api.ts'
import {
  AuthenticationError,
  AuthenticationThrottledError,
  RegistrySyncError,
} from '../../src/errors/index.ts'
import { HttpClient } from '../../src/http/index.ts'
import { Temporal } from '../../src/temporal.ts'
import { MS_PER_MINUTE } from '../../src/time-units.ts'
import {
  cast,
  createLogger,
  mockFetchResponse,
  mockTemporalNowInstant,
} from '../helpers.ts'

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

interface Store {
  readonly get: Mock<(key: string) => string | null | undefined>
  readonly manager: SettingManager
  readonly set: Mock<(key: string, value: string) => void>
  readonly unset: Mock<(key: string) => void>
  readonly values: Map<string, string>
}

/**
 * Consumer-defined sync payload, standing in for the SDKs' own.
 */
interface SyncParams {
  readonly ids?: string[] | undefined
}

const BASE_URL = 'https://session.test/api'

const EXPIRY = '2030-01-01T00:00:00Z'

const CLOCK_BEFORE = '2026-01-01T00:00:00Z'
const CLOCK_AFTER = '2025-01-01T00:00:00Z'

const CREDENTIALS: LoginCredentials = {
  password: 'secret',
  username: 'user@example.test',
}

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVER_ERROR = 500
const HTTP_BAD_GATEWAY = 502

const CONCURRENT_CALLERS = 4
const RATE_LIMIT_HOURS = 2
const BACKOFF_FAILURE_MS = 900_000
const BACKOFF_THROTTLE_MS = 7_200_000
const RETRY_WINDOW_MS = 2000
const ANNOUNCED_MINUTES = 60
const ABSURD_HOURS = 9

const mockFetch = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', mockFetch)

const respondWith = (status: number): void => {
  mockFetch.mockResolvedValueOnce(mockFetchResponse({ ok: true }, {}, status))
}

const createStore = (hasUnset = true): Store => {
  const values = new Map<string, string>()
  const get = vi.fn<(key: string) => string | null | undefined>((key) =>
    values.get(key),
  )
  const set = vi.fn<(key: string, value: string) => void>((key, value) => {
    values.set(key, value)
  })
  const unset = vi.fn<(key: string) => void>((key) => {
    values.delete(key)
  })
  return {
    get,
    manager: hasUnset ? { get, set, unset } : { get, set },
    set,
    unset,
    values,
  }
}

const withCredentials = (store: Store): Store => {
  store.values.set('username', CREDENTIALS.username)
  store.values.set('password', CREDENTIALS.password)
  return store
}

const sortedKeys = (calls: [string, ...unknown[]][]): string[] =>
  [...new Set(calls.map(([key]) => key))].toSorted((left, right) =>
    left.localeCompare(right),
  )

/**
 * Concrete stand-in for a consuming SDK: it implements the thirteen
 * seam members over a minimal in-memory protocol (a token, an expiry, a
 * registry) and re-exposes the protected template members so the suite
 * can drive them exactly as a subclass does.
 */
class Harness extends SessionAPI<SyncParams> {
  public authError?: Error | undefined

  public autoSyncError?: Error | undefined

  public enforceError?: Error | undefined

  public enforceGate?: Promise<void> | undefined

  public isReauthenticated = false

  public onDoAuthenticate?: (() => void) | undefined

  public onEnforceRegistrySync?: (() => void) | undefined

  public onReuseSucceeded?: (() => void) | undefined

  public refreshError?: Error | undefined

  public readonly registry: string[] = []

  public requiresSessionRefresh = false

  // Ordered trace of the hooks the template actually called.
  public readonly seen: string[] = []

  // melcloud Classic's wiring: its reactive recovery IS
  // `resumeSession`, taken with the rejected credential still standing.
  public shouldReauthenticateViaResume = false

  public shouldReuseSucceed = true

  public syncRegistryGate?: Promise<void> | undefined

  public token = ''

  // The one boot-time wire failure both registry hooks meet — the
  // enforced sync propagates it, the probe swallows it.
  public wireError?: Error | undefined

  public get isRateLimited(): boolean {
    return this.rateLimitGate?.isPaused === true
  }

  public constructor(
    config: SessionAPIConfig<SyncParams> = {},
    options: Partial<Omit<SessionAPIOptions, 'syncCallback'>> = {},
  ) {
    super(config, {
      defaultSyncIntervalMinutes: false,
      transport: new HttpClient({ baseURL: BASE_URL, timeout: 0 }),
      syncCallback: async () => this.autoSync(),
      ...options,
    })
  }

  public applyNoCredentials(): void {
    this.applyCredentials()
  }

  public async autoSync(): Promise<string[]> {
    this.seen.push('autoSync')
    await Promise.resolve()
    if (this.autoSyncError !== undefined) {
      throw this.autoSyncError
    }
    return this.fetchMutable()
  }

  public async bestEffortCycle(error: Error): Promise<string[]> {
    return this.runBestEffortSyncCycle(async () => this.strictCycle(error))
  }

  public async callDispatch(
    method: string,
    url: string,
    config?: Record<string, unknown>,
  ): Promise<void> {
    await this.dispatch(method, url, config)
  }

  public async callEnsureSession(): Promise<void> {
    await this.ensureSession()
  }

  public callLogError(error: unknown): void {
    this.logError(error)
  }

  public async callRequest(
    method: string,
    url: string,
    config?: Record<string, unknown>,
  ): Promise<number> {
    const { status } = await this.request(method, url, config)
    return status
  }

  public async callTryReuseSession(): Promise<boolean> {
    return this.tryReuseSession()
  }

  // Mutable-array shape (melcloud's `fetch()`): the element type must
  // survive the best-effort wrapper's empty fallback unchanged.
  public async fetchMutable(): Promise<string[]> {
    return this.runBestEffortSyncCycle(async () =>
      this.runSyncCycle(async () => {
        await Promise.resolve()
        return [...this.registry]
      }),
    )
  }

  // Readonly-array shape (heatzy's `fetch()`): same two templates, same
  // call sites, a stricter element type.
  public async fetchReadonly(): Promise<readonly string[]> {
    return this.runBestEffortSyncCycle(async () =>
      this.runSyncCycle(async (): Promise<readonly string[]> => {
        await Promise.resolve()
        return this.registry
      }),
    )
  }

  public isAuthenticated(): boolean {
    return this.token !== ''
  }

  public readExpiry(): string {
    return this.expiry
  }

  public storeCredentials(username?: string, password?: string): void {
    this.applyCredentials(username, password)
  }

  public async strictCycle(error: Error): Promise<string[]> {
    return this.runSyncCycle(async (): Promise<string[]> => {
      await Promise.resolve()
      throw error
    })
  }

  public writeExpiry(value: string): void {
    this.expiry = value
  }

  protected clearPersistedSession(): void {
    this.seen.push('clearPersistedSession')
    this.token = ''
    this.expiry = ''
  }

  protected clearRegistry(): void {
    this.seen.push('clearRegistry')
    this.registry.length = 0
  }

  protected async doAuthenticate(credentials: LoginCredentials): Promise<void> {
    this.seen.push('doAuthenticate')
    await Promise.resolve()
    this.onDoAuthenticate?.()
    if (this.authError !== undefined) {
      throw this.authError
    }
    this.token = `token:${credentials.username}`
    this.expiry = EXPIRY
  }

  // Failures PROPAGATE by contract: a sign-in must not resolve over an
  // empty registry.
  protected async enforceRegistrySync(): Promise<void> {
    this.seen.push('enforceRegistrySync')
    this.onEnforceRegistrySync?.()
    await (this.enforceGate ?? Promise.resolve())
    const failure = this.enforceError ?? this.wireError
    if (failure !== undefined) {
      throw failure
    }
    this.registry.push('device')
  }

  protected getAuthHeaders(): Record<string, string> {
    return this.token === '' ? {} : { 'x-session-token': this.token }
  }

  protected hasPersistedSession(): boolean {
    return this.token !== ''
  }

  protected needsSessionRefresh(): boolean {
    return this.requiresSessionRefresh
  }

  protected async performSessionRefresh(): Promise<void> {
    this.seen.push('performSessionRefresh')
    await Promise.resolve()
    if (this.refreshError !== undefined) {
      throw this.refreshError
    }
  }

  protected async reauthenticate(): Promise<boolean> {
    this.seen.push('reauthenticate')
    if (this.shouldReauthenticateViaResume) {
      return this.resumeSession()
    }
    await Promise.resolve()
    return this.isReauthenticated
  }

  protected reuseSucceeded(): boolean {
    this.seen.push('reuseSucceeded')
    this.onReuseSucceeded?.()
    return this.shouldReuseSucceed
  }

  // Failures are LOGGED AND SWALLOWED by contract: the probe runs on
  // the boot path, where a network blip must degrade to "not
  // authenticated yet", never to a rejected `create()`.
  protected async syncRegistry(): Promise<void> {
    this.seen.push('syncRegistry')
    await (this.syncRegistryGate ?? Promise.resolve())
    if (this.wireError !== undefined) {
      this.logger.error('Failed to fetch devices:', this.wireError)
    }
  }
}

const seedSession = (harness: Harness): void => {
  harness.token = 'token:seeded'
}

const lastInit = (): FetchInit => {
  const init = mockFetch.mock.lastCall?.[1]
  if (init === undefined) {
    throw new TypeError('fetch was not called')
  }
  return init
}

const lastHeaders = (): Record<string, string> => cast(lastInit().headers)

describe(SessionAPI, () => {
  afterEach(() => {
    mockFetch.mockReset()
  })

  describe('construction', () => {
    it('defaults the logger to console when the host supplies none', () => {
      using harness = new Harness()

      expect(harness.logger).toBe(console)
    })

    it('leaves the logger unwrapped when no label is configured', () => {
      const logger = createLogger()
      using harness = new Harness({ logger })

      expect(harness.logger).toBe(logger)
    })

    it('prefixes every log line with the configured label', () => {
      const logger = createLogger()
      using harness = new Harness({ logger }, { logLabel: '[Test]' })

      harness.logger.log('hello')
      harness.logger.error('boom')

      expect(logger.log).toHaveBeenCalledWith('[Test]', 'hello')
      expect(logger.error).toHaveBeenCalledWith('[Test]', 'boom')
    })

    // Preserved asymmetry, not an oversight: the labelled logger goes
    // to every seat EXCEPT the sync manager, which keeps the raw one —
    // these strings land verbatim in user diagnostic reports, so the
    // move reproduces them byte for byte.
    it('hands the auto-sync manager the raw logger, not the labelled one', async () => {
      const logger = createLogger()
      using harness = new Harness({ logger }, { logLabel: '[Test]' })
      const error = new Error('auto-sync broke')
      harness.autoSyncError = error
      vi.useFakeTimers()

      harness.setSyncInterval(1)
      await vi.advanceTimersByTimeAsync(MS_PER_MINUTE)
      vi.useRealTimers()

      expect(logger.error).toHaveBeenCalledWith('Auto-sync failed:', error)
    })

    it('builds no rate-limit rung when no window is configured', () => {
      using harness = new Harness()

      expect(harness.isRateLimited).toBe(false)
    })

    it('honours the caller sync interval over the subclass default', async () => {
      using harness = new Harness(
        { syncIntervalMinutes: 1 },
        { defaultSyncIntervalMinutes: false },
      )
      vi.useFakeTimers()
      seedSession(harness)

      await harness.fetchMutable()
      await vi.advanceTimersByTimeAsync(MS_PER_MINUTE)
      vi.useRealTimers()

      expect(harness.seen).toContain('autoSync')
    })
  })

  describe('persisted keys', () => {
    // The storage key IS the accessor name, resolved once at decoration
    // time. Hosts already hold values under these four strings, so a
    // rename here strands every installed user's credentials and their
    // login backoff.
    it('writes the four session fields under exactly their accessor names', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })
      harness.authError = new AuthenticationError('rejected')

      harness.storeCredentials(CREDENTIALS.username, CREDENTIALS.password)
      harness.writeExpiry(EXPIRY)

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'rejected',
      )

      expect(sortedKeys(store.set.mock.calls)).toStrictEqual([
        'expiry',
        'loginBackoffUntil',
        'password',
        'username',
      ])
      expect(store.values.get('username')).toBe(CREDENTIALS.username)
      expect(store.values.get('password')).toBe(CREDENTIALS.password)
      expect(store.values.get('expiry')).toBe(EXPIRY)
    })

    it('reads the same names back from the host store', () => {
      const store = createStore()
      store.values.set('expiry', EXPIRY)
      using harness = new Harness({ settingManager: store.manager })

      expect(harness.readExpiry()).toBe(EXPIRY)
      expect(store.get).toHaveBeenCalledWith('expiry')
    })

    it('deletes those names on sign-out when the host delegates unset', () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })

      harness.storeCredentials(CREDENTIALS.username, CREDENTIALS.password)
      harness.writeExpiry(EXPIRY)
      harness.logOut()

      expect(sortedKeys(store.unset.mock.calls)).toStrictEqual([
        'expiry',
        'loginBackoffUntil',
        'password',
        'username',
      ])
      expect(store.values.size).toBe(0)
    })

    it('falls back to an empty string when the host cannot unset', () => {
      const store = createStore(false)
      using harness = new Harness({ settingManager: store.manager })

      harness.storeCredentials(CREDENTIALS.username, CREDENTIALS.password)
      harness.logOut()

      expect(store.values.get('username')).toBe('')
      expect(store.values.get('password')).toBe('')
    })

    it('keeps the in-memory field when no store is configured', () => {
      using harness = new Harness()

      harness.writeExpiry(EXPIRY)

      expect(harness.readExpiry()).toBe(EXPIRY)
    })

    it('leaves a field untouched when its argument is omitted', () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })

      harness.applyNoCredentials()

      expect(store.set).not.toHaveBeenCalled()
    })
  })

  describe('login backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      mockTemporalNowInstant()
    })

    afterEach(() => {
      vi.mocked(Temporal.Now.instant).mockRestore()
      vi.useRealTimers()
    })

    it('arms the backoff on a rejected sign-in', async () => {
      const store = createStore()
      const logger = createLogger()
      using harness = new Harness({ logger, settingManager: store.manager })
      harness.authError = new AuthenticationError('rejected')

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'rejected',
      )

      expect(store.values.get('loginBackoffUntil')).toBe(
        String(Date.now() + BACKOFF_FAILURE_MS),
      )
      expect(logger.error).toHaveBeenCalledWith(
        'Automatic sign-ins paused for 15 minutes after a rejected login',
      )
    })

    it('does not arm the backoff on a transport failure', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })
      harness.authError = new TypeError('fetch failed')

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'fetch failed',
      )

      expect(store.values.has('loginBackoffUntil')).toBe(false)
    })

    // The gate guards the LOGIN, not the sync that follows it: the
    // server already accepted the credentials, so pausing sign-ins
    // would lock the user out over a registry problem.
    it('does not arm the backoff when the post-auth registry sync fails', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })
      harness.enforceError = new AuthenticationError('registry refused')

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        RegistrySyncError,
      )

      expect(store.values.has('loginBackoffUntil')).toBe(false)
      expect(harness.isAuthenticated()).toBe(true)
    })

    it('widens the pause to the announced window on a throttle', async () => {
      const store = createStore()
      const logger = createLogger()
      using harness = new Harness({ logger, settingManager: store.manager })
      harness.authError = new AuthenticationThrottledError('throttled', {
        retryAfter: Temporal.Duration.from({ minutes: ANNOUNCED_MINUTES }),
      })

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'throttled',
      )

      expect(store.values.get('loginBackoffUntil')).toBe(
        String(Date.now() + ANNOUNCED_MINUTES * MS_PER_MINUTE),
      )
      expect(logger.error).toHaveBeenCalledWith(
        'Automatic sign-ins paused for 60 minutes after a rejected login',
      )
    })

    it('caps an absurd announced window at the throttle ceiling', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })
      harness.authError = new AuthenticationThrottledError('throttled', {
        retryAfter: Temporal.Duration.from({ hours: ABSURD_HOURS }),
      })

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'throttled',
      )

      expect(store.values.get('loginBackoffUntil')).toBe(
        String(Date.now() + BACKOFF_THROTTLE_MS),
      )
    })

    it('falls back to the ceiling when the upstream announced no window', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })
      harness.authError = new AuthenticationThrottledError('throttled')

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'throttled',
      )

      expect(store.values.get('loginBackoffUntil')).toBe(
        String(Date.now() + BACKOFF_THROTTLE_MS),
      )
    })

    it('refuses an automatic resume while the pause holds', async () => {
      const store = withCredentials(createStore())
      store.values.set('loginBackoffUntil', String(Date.now() + MS_PER_MINUTE))
      using harness = new Harness({ settingManager: store.manager })

      await expect(harness.resumeSession()).resolves.toBe(false)
      expect(harness.seen).not.toContain('doAuthenticate')
    })

    it('resumes once the pause has elapsed', async () => {
      const store = withCredentials(createStore())
      store.values.set('loginBackoffUntil', String(Date.now() - 1))
      using harness = new Harness({ settingManager: store.manager })

      await expect(harness.resumeSession()).resolves.toBe(true)
    })

    it('reads a corrupt deadline as no pause at all', async () => {
      const store = withCredentials(createStore())
      store.values.set('loginBackoffUntil', 'not-a-number')
      using harness = new Harness({ settingManager: store.manager })

      await expect(harness.resumeSession()).resolves.toBe(true)
    })

    it('clears the pause once a sign-in is accepted', async () => {
      const store = createStore()
      store.values.set('loginBackoffUntil', String(Date.now() + MS_PER_MINUTE))
      using harness = new Harness({ settingManager: store.manager })

      await harness.authenticate(CREDENTIALS)

      expect(store.values.has('loginBackoffUntil')).toBe(false)
    })
  })

  describe('authenticate', () => {
    it('persists the pair and enforces the post-auth sync', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })

      await harness.authenticate(CREDENTIALS)

      expect(harness.seen).toStrictEqual([
        'doAuthenticate',
        'enforceRegistrySync',
      ])
      expect(store.values.get('username')).toBe(CREDENTIALS.username)
      expect(harness.registry).toStrictEqual(['device'])
    })

    it('leaves the stored pair untouched when the server refuses', async () => {
      const store = createStore()
      store.values.set('username', 'previous@example.test')
      store.values.set('password', 'previous')
      using harness = new Harness({ settingManager: store.manager })
      harness.authError = new AuthenticationError('rejected')

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        'rejected',
      )

      expect(store.values.get('username')).toBe('previous@example.test')
      expect(store.values.get('password')).toBe('previous')
    })

    // The explicit sign-out always wins over the work it overlapped.
    it('discards a sign-in that a sign-out raced', async () => {
      const store = createStore()
      using harness = new Harness({ settingManager: store.manager })
      harness.onDoAuthenticate = (): void => {
        harness.logOut()
      }

      await harness.authenticate(CREDENTIALS)

      expect(harness.isAuthenticated()).toBe(false)
      expect(harness.seen).not.toContain('enforceRegistrySync')
      expect(store.values.size).toBe(0)
    })
  })

  describe('resumeSession', () => {
    it('reports no persisted credentials as a silent false', async () => {
      using harness = new Harness()

      await expect(harness.resumeSession()).resolves.toBe(false)
      expect(harness.seen).not.toContain('doAuthenticate')
    })

    it('reports a missing password as no credentials', async () => {
      const store = createStore()
      store.values.set('username', CREDENTIALS.username)
      using harness = new Harness({ settingManager: store.manager })

      await expect(harness.resumeSession()).resolves.toBe(false)
    })

    it('reports a missing username as no credentials', async () => {
      const store = createStore()
      store.values.set('password', CREDENTIALS.password)
      using harness = new Harness({ settingManager: store.manager })

      await expect(harness.resumeSession()).resolves.toBe(false)
    })

    it('logs and swallows a rejected sign-in', async () => {
      const store = withCredentials(createStore())
      const logger = createLogger()
      using harness = new Harness({ logger, settingManager: store.manager })
      const error = new AuthenticationError('rejected')
      harness.authError = error

      await expect(harness.resumeSession()).resolves.toBe(false)
      expect(logger.error).toHaveBeenCalledWith('Session resume failed:', error)
    })

    // One of the two shapes the catch judges — by the SIGN-IN
    // ROUND-TRIP, not by the throw: an ACCEPTED credential whose
    // enforced registry cycle then threw IS a resume, because the
    // session it established stands. A `false` here would have
    // `initialize()` emit a spurious `onAuthenticationLost`, prompting
    // the user to re-enter credentials that had just worked.
    it('reports an accepted sign-in as a resume even when the enforced sync throws', async () => {
      const store = withCredentials(createStore())
      using harness = new Harness({ settingManager: store.manager })
      harness.enforceError = new Error('registry broke')

      await expect(harness.resumeSession()).resolves.toBe(true)
    })

    // The other shape, and the one a session cannot judge: the server
    // REFUSED the credentials while a session established before the
    // attempt is still standing. A `true` there reports a re-sign-in
    // that never happened, and the caller spends the credential the
    // server has just rejected — when that caller is the reactive
    // auth-failure path, the replay clause under "resilience rungs" is
    // what it costs. The session itself is untouched: only the VERDICT
    // is at stake, which is what makes the two shapes distinguishable
    // by the sign-in round-trip alone.
    it('reports a refused re-sign-in as a failed resume, standing session or not', async () => {
      const store = withCredentials(createStore())
      const logger = createLogger()
      using harness = new Harness({ logger, settingManager: store.manager })
      seedSession(harness)
      const error = new AuthenticationError('rejected')
      harness.authError = error

      await expect(harness.resumeSession()).resolves.toBe(false)

      // The refusal left the previous session alone — this clause is
      // about the verdict, never about clearing.
      expect(harness.isAuthenticated()).toBe(true)
      expect(logger.error).toHaveBeenCalledWith('Session resume failed:', error)
    })
  })

  // `resumeSession` is single-flight, one lifecycle layer above the
  // refresh handle: the paths that race at boot (a background
  // `initialize`, the first request's `ensureSession`, a reactive
  // auth failure) collapse onto ONE sign-in round-trip — without the
  // memo, two callers could both pass the login-backoff gate before
  // either refusal armed it, against an upstream whose measured
  // throttle threshold was four sign-ins in seventy seconds. Every
  // caller's verdict describes the one shared attempt.
  describe('resumeSession single-flight', () => {
    it.each([
      {
        error: undefined,
        expectedHooks: ['doAuthenticate', 'enforceRegistrySync'],
        isResumed: true,
        label: 'accepted',
      },
      {
        error: new AuthenticationError('rejected'),
        expectedHooks: ['doAuthenticate'],
        isResumed: false,
        label: 'refused',
      },
    ])(
      'collapses concurrent callers onto one $label sign-in round-trip',
      async ({ error, expectedHooks, isResumed }) => {
        const store = withCredentials(createStore())
        using harness = new Harness({ settingManager: store.manager })
        harness.authError = error

        const verdicts = await Promise.all(
          Array.from({ length: CONCURRENT_CALLERS }, async () =>
            harness.resumeSession(),
          ),
        )

        expect(verdicts).toStrictEqual(
          Array.from({ length: CONCURRENT_CALLERS }, () => isResumed),
        )
        expect(harness.seen).toStrictEqual(expectedHooks)
      },
    )

    it('releases the in-flight handle once the attempt settles', async () => {
      const store = withCredentials(createStore())
      using harness = new Harness({ settingManager: store.manager })

      await expect(harness.resumeSession()).resolves.toBe(true)
      await expect(harness.resumeSession()).resolves.toBe(true)

      expect(harness.seen).toStrictEqual([
        'doAuthenticate',
        'enforceRegistrySync',
        'doAuthenticate',
        'enforceRegistrySync',
      ])
    })

    // The branch the concurrent clauses cannot reach: a caller joining
    // AFTER the sign-in verdict, while the enforced registry sync
    // still runs — it must read the determined verdict instead of
    // awaiting the shared promise, because the one real caller in that
    // window is the reactive auth-failure path the enforced sync
    // itself triggered, and awaiting there would wait on its own
    // caller.
    it('answers a caller joining after the sign-in verdict without awaiting the enforced sync', async () => {
      const gate = Promise.withResolvers<undefined>()
      const syncStarted = Promise.withResolvers<undefined>()
      const store = withCredentials(createStore())
      using harness = new Harness({ settingManager: store.manager })
      harness.enforceGate = gate.promise
      harness.onEnforceRegistrySync = (): void => {
        syncStarted.resolve(undefined)
      }

      const shared = harness.resumeSession()
      // Let the sign-in round-trip resolve and the enforced sync
      // start; the flight is still open when the second caller joins.
      await syncStarted.promise

      await expect(harness.resumeSession()).resolves.toBe(true)

      gate.resolve(undefined)

      await expect(shared).resolves.toBe(true)

      expect(harness.seen).toStrictEqual([
        'doAuthenticate',
        'enforceRegistrySync',
      ])
    })
  })

  // The refusal is RECORDED even though the stored session is not
  // cleared (a refusal changes the verdict, never the session):
  // without the record, the loss-surfacing epilogue keyed on
  // `isAuthenticated()` alone, so a server-side password change left
  // the host reading "signed in" over a dead account indefinitely —
  // `onAuthenticationLost` could never fire while the stale session
  // stood.
  describe('credential-refusal verdict', () => {
    it('surfaces onAuthenticationLost once per episode when a cycle settles on a refused credential over a standing session', async () => {
      const store = withCredentials(createStore())
      const onAuthenticationLost = vi.fn<() => void>()
      using harness = new Harness({
        events: { onAuthenticationLost },
        settingManager: store.manager,
      })
      await harness.authenticate(CREDENTIALS)
      harness.authError = new AuthenticationError('rejected')

      await expect(harness.resumeSession()).resolves.toBe(false)

      // The cycle epilogue owns the surfacing, so nothing has been
      // announced yet — and the session itself still stands: the
      // verdict, not the store, changed.
      expect(onAuthenticationLost).not.toHaveBeenCalled()
      expect(harness.isAuthenticated()).toBe(true)

      await harness.fetchMutable()
      await harness.fetchMutable()

      expect(onAuthenticationLost).toHaveBeenCalledTimes(1)
    })

    it('serves the session again and announces the recovery once a sign-in is accepted after a refusal', async () => {
      const store = withCredentials(createStore())
      const onAuthenticationLost = vi.fn<() => void>()
      const onAuthenticationRestored = vi.fn<() => void>()
      using harness = new Harness({
        events: { onAuthenticationLost, onAuthenticationRestored },
        settingManager: store.manager,
      })
      await harness.authenticate(CREDENTIALS)
      harness.authError = new AuthenticationError('rejected')

      await expect(harness.resumeSession()).resolves.toBe(false)

      await harness.fetchMutable()
      harness.authError = undefined

      await harness.authenticate(CREDENTIALS)
      await harness.fetchMutable()

      expect(onAuthenticationLost).toHaveBeenCalledTimes(1)
      expect(onAuthenticationRestored).toHaveBeenCalledTimes(1)
    })

    // Neither shape is a verdict on the pair: a throttle refuses the
    // ATTEMPT while saying nothing about the credentials (asking the
    // user to re-log would keep the lockout alive), and a transport
    // failure says nothing at all.
    it.each([
      {
        error: new AuthenticationThrottledError('throttled'),
        label: 'throttled',
      },
      { error: new TypeError('fetch failed'), label: 'failed at transport' },
    ])(
      'keeps serving the standing session when a re-sign-in merely $label',
      async ({ error }) => {
        const store = withCredentials(createStore())
        const onAuthenticationLost = vi.fn<() => void>()
        using harness = new Harness({
          events: { onAuthenticationLost },
          settingManager: store.manager,
        })
        await harness.authenticate(CREDENTIALS)
        harness.authError = error

        await expect(harness.resumeSession()).resolves.toBe(false)

        await harness.fetchMutable()

        expect(onAuthenticationLost).not.toHaveBeenCalled()
      },
    )
  })

  describe('initialize and start', () => {
    it('stops after a successful session reuse', async () => {
      using harness = new Harness()
      seedSession(harness)

      await harness.initialize()

      expect(harness.seen).toStrictEqual(['syncRegistry', 'reuseSucceeded'])
    })

    it('falls through to a full resume when the probe fails', async () => {
      const store = withCredentials(createStore())
      using harness = new Harness({ settingManager: store.manager })
      seedSession(harness)
      harness.shouldReuseSucceed = false

      await harness.initialize()

      expect(harness.seen).toStrictEqual([
        'syncRegistry',
        'reuseSucceeded',
        'doAuthenticate',
        'enforceRegistrySync',
      ])
    })

    it('skips the probe when nothing is persisted', async () => {
      using harness = new Harness()

      await expect(harness.callTryReuseSession()).resolves.toBe(false)
      expect(harness.seen).toStrictEqual([])
    })

    it('announces the loss when a recoverable restore fails', async () => {
      const store = withCredentials(createStore())
      const onAuthenticationLost = vi.fn<() => void>()
      using harness = new Harness({
        events: { onAuthenticationLost },
        settingManager: store.manager,
      })
      harness.authError = new AuthenticationError('rejected')

      await harness.initialize()

      expect(onAuthenticationLost).toHaveBeenCalledTimes(1)
    })

    it('stays silent when there was nothing to recover', async () => {
      const onAuthenticationLost = vi.fn<() => void>()
      using harness = new Harness({ events: { onAuthenticationLost } })

      await harness.initialize()

      expect(onAuthenticationLost).not.toHaveBeenCalled()
    })

    it('awaits the restore in the foreground', async () => {
      using harness = new Harness()
      seedSession(harness)

      await harness.start()

      expect(harness.seen).toStrictEqual(['syncRegistry', 'reuseSucceeded'])
    })

    it('detaches the restore in the background', async () => {
      const gate = Promise.withResolvers<undefined>()
      const settled = Promise.withResolvers<undefined>()
      using harness = new Harness()
      seedSession(harness)
      harness.syncRegistryGate = gate.promise
      harness.onReuseSucceeded = (): void => {
        settled.resolve(undefined)
      }

      await harness.start(true)

      expect(harness.seen).toStrictEqual(['syncRegistry'])

      gate.resolve(undefined)
      await settled.promise

      expect(harness.seen).toStrictEqual(['syncRegistry', 'reuseSucceeded'])
    })
  })

  // The two registry hooks are NOT interchangeable, and the split is
  // load-bearing in both directions. `tryReuseSession` calls the
  // BEST-EFFORT `syncRegistry` because `initialize()` has no try/catch
  // and every `create()` factory awaits it: a propagating probe would
  // turn a boot-time blip into an app that refuses to start. The
  // enforced post-auth sync is the opposite — it must propagate, or a
  // sign-in resolves over an empty registry.
  describe('probe versus enforced sync', () => {
    it('keeps a boot-time probe failure off the caller and off the session', async () => {
      const logger = createLogger()
      using harness = new Harness({ logger })
      seedSession(harness)
      harness.wireError = new Error('offline')
      harness.shouldReuseSucceed = false

      await expect(harness.start()).resolves.toBeUndefined()

      expect(harness.token).toBe('token:seeded')
      expect(harness.seen).toContain('syncRegistry')
      expect(harness.seen).not.toContain('enforceRegistrySync')
      expect(harness.seen).not.toContain('clearPersistedSession')
    })

    it('propagates an enforced post-auth sync failure out of authenticate', async () => {
      using harness = new Harness()
      harness.wireError = new Error('offline')

      await expect(harness.authenticate(CREDENTIALS)).rejects.toThrow(
        RegistrySyncError,
      )

      expect(harness.seen).toStrictEqual([
        'doAuthenticate',
        'enforceRegistrySync',
      ])
      expect(harness.registry).toStrictEqual([])
    })

    // The enforced-sync failure carries its own TYPE because consumers
    // could not tell it from a refused credential without re-deriving
    // the verdict from `isAuthenticated()` — the judge-by-the-session
    // discriminator this mechanism already retired once, with a real
    // false positive: a transport failure during a sign-in over a
    // PRE-EXISTING live session (a user switching accounts) reads
    // "signed in, stale list" while the new pair was never accepted.
    it('wraps an enforced-sync failure in RegistrySyncError, the sync failure preserved as its cause', async () => {
      using harness = new Harness()
      const failure = new Error('registry broke')
      harness.enforceError = failure

      const signIn = harness.authenticate(CREDENTIALS)

      await expect(signIn).rejects.toBeInstanceOf(RegistrySyncError)
      // The wrap adds the type without eating the evidence: the sync's
      // own failure stays readable on `cause`.
      await expect(signIn).rejects.toMatchObject({ cause: failure })
    })

    it('never wraps a refused credential in RegistrySyncError', async () => {
      using harness = new Harness()
      harness.authError = new AuthenticationError('rejected')

      const signIn = harness.authenticate(CREDENTIALS)

      await expect(signIn).rejects.toBeInstanceOf(AuthenticationError)
      await expect(signIn).rejects.not.toBeInstanceOf(RegistrySyncError)
    })
  })

  describe('logOut', () => {
    it('clears the session, the pair, the backoff, the timer and the registry', () => {
      const store = createStore()
      store.values.set('loginBackoffUntil', String(Number.MAX_SAFE_INTEGER))
      using harness = new Harness({ settingManager: store.manager })
      seedSession(harness)
      harness.registry.push('device')

      harness.logOut()

      expect(harness.isAuthenticated()).toBe(false)
      expect(harness.registry).toStrictEqual([])
      expect(store.values.has('loginBackoffUntil')).toBe(false)
      expect(harness.seen).toStrictEqual([
        'clearPersistedSession',
        'clearRegistry',
      ])
    })
  })

  describe('notifySync', () => {
    it('routes the payload through the lifecycle emitter', async () => {
      const onSyncComplete = vi.fn<(params?: SyncParams) => Promise<void>>()
      onSyncComplete.mockResolvedValue()
      using harness = new Harness({ events: { onSyncComplete } })

      await harness.notifySync({ ids: ['a'] })

      expect(onSyncComplete).toHaveBeenCalledWith({ ids: ['a'] })
    })
  })

  describe('ensureSession', () => {
    it('skips the refresh when the session is fresh', async () => {
      using harness = new Harness()

      await harness.callEnsureSession()

      expect(harness.seen).toStrictEqual([])
    })

    it('deduplicates concurrent refreshes behind one round-trip', async () => {
      using harness = new Harness()
      harness.requiresSessionRefresh = true

      await Promise.all([
        harness.callEnsureSession(),
        harness.callEnsureSession(),
      ])

      expect(harness.seen).toStrictEqual(['performSessionRefresh'])
    })

    it('releases the handle once the refresh settles', async () => {
      using harness = new Harness()
      harness.requiresSessionRefresh = true

      await harness.callEnsureSession()
      await harness.callEnsureSession()

      expect(harness.seen).toStrictEqual([
        'performSessionRefresh',
        'performSessionRefresh',
      ])
    })

    it('releases the handle when the refresh rejects', async () => {
      using harness = new Harness()
      harness.requiresSessionRefresh = true
      harness.refreshError = new Error('refresh broke')

      await expect(harness.callEnsureSession()).rejects.toThrow('refresh broke')
      await expect(harness.callEnsureSession()).rejects.toThrow('refresh broke')

      expect(harness.seen).toStrictEqual([
        'performSessionRefresh',
        'performSessionRefresh',
      ])
    })
  })

  describe('dispatch', () => {
    it('merges the per-call headers under the auth headers', async () => {
      using harness = new Harness()
      seedSession(harness)
      respondWith(HTTP_OK)

      await harness.callDispatch('post', '/control', {
        data: { power: true },
        headers: { 'x-trace': 'abc' },
      })

      expect(lastHeaders()['x-trace']).toBe('abc')
      expect(lastHeaders()['x-session-token']).toBe('token:seeded')
    })

    // The auth headers are the client's own: a per-call header may not
    // displace the credential the request rides on.
    it('lets the auth headers win over a colliding per-call header', async () => {
      using harness = new Harness()
      seedSession(harness)
      respondWith(HTTP_OK)

      await harness.callDispatch('get', '/devices', {
        headers: { 'x-session-token': 'forged' },
      })

      expect(lastHeaders()['x-session-token']).toBe('token:seeded')
    })

    it('sends the auth headers alone when the call supplies none', async () => {
      using harness = new Harness()
      seedSession(harness)
      respondWith(HTTP_OK)

      await harness.callDispatch('get', '/devices')

      expect(lastHeaders()).toStrictEqual({ 'x-session-token': 'token:seeded' })
    })

    it('attaches the configured shutdown signal to every request', async () => {
      const controller = new AbortController()
      using harness = new Harness({ abortSignal: controller.signal })
      respondWith(HTTP_OK)

      await harness.callDispatch('get', '/devices')

      expect(lastInit().signal).toBe(controller.signal)
    })

    it('sends no signal when the host configured none', async () => {
      using harness = new Harness()
      respondWith(HTTP_OK)

      await harness.callDispatch('get', '/devices')

      expect(lastInit().signal).toBeUndefined()
    })

    it('traces the request and the response through the logger', async () => {
      const logger = createLogger()
      using harness = new Harness({ logger })
      respondWith(HTTP_OK)

      await harness.callDispatch('get', '/devices')

      expect(logger.log).toHaveBeenCalledTimes(2)
    })
  })

  describe('request pipeline', () => {
    it('emits start and completion around a successful call', async () => {
      const onRequestComplete = vi.fn<(event: { status: number }) => void>()
      const onRequestStart = vi.fn<() => void>()
      using harness = new Harness({
        events: { onRequestComplete, onRequestStart },
      })
      respondWith(HTTP_OK)

      await expect(harness.callRequest('get', '/devices')).resolves.toBe(
        HTTP_OK,
      )

      expect(onRequestStart).toHaveBeenCalledTimes(1)
      expect(onRequestComplete).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', status: HTTP_OK }),
      )
    })

    it('emits the error event and logs the call before rethrowing', async () => {
      const logger = createLogger()
      const onRequestError = vi.fn<() => void>()
      using harness = new Harness({ events: { onRequestError }, logger })
      respondWith(HTTP_SERVER_ERROR)

      await expect(harness.callRequest('post', '/control')).rejects.toThrow(
        'Request failed with status code 500',
      )

      expect(onRequestError).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('stays quiet in the call log for a non-HTTP failure', async () => {
      const logger = createLogger()
      using harness = new Harness({ logger })
      mockFetch.mockRejectedValueOnce(new TypeError('offline'))

      await expect(harness.callRequest('get', '/devices')).rejects.toThrow(
        'offline',
      )

      expect(logger.error).not.toHaveBeenCalled()
    })

    it('logs nothing for a value that is not an HTTP error', () => {
      const logger = createLogger()
      using harness = new Harness({ logger })

      harness.callLogError(new Error('plain'))

      expect(logger.error).not.toHaveBeenCalled()
    })

    it('refreshes the session before the request leaves', async () => {
      using harness = new Harness()
      harness.requiresSessionRefresh = true
      respondWith(HTTP_OK)

      await harness.callRequest('get', '/devices')

      expect(harness.seen[0]).toBe('performSessionRefresh')
    })

    // The duration clock is monotonic: a system-clock jump mid-request
    // must not hand every observer a negative `durationMs`. Fake timers
    // move `Date.now()` and leave `performance.now()` alone, which is
    // exactly the divergence under test.
    it('measures the duration on a clock a system-time jump cannot move', async () => {
      const onRequestComplete = vi.fn<(event: { durationMs: number }) => void>()
      using harness = new Harness({ events: { onRequestComplete } })
      vi.useFakeTimers()
      vi.setSystemTime(Temporal.Instant.from(CLOCK_BEFORE).epochMilliseconds)
      mockFetch.mockImplementationOnce(async (): Promise<Response> => {
        await Promise.resolve()
        vi.setSystemTime(Temporal.Instant.from(CLOCK_AFTER).epochMilliseconds)
        return mockFetchResponse({ ok: true }, {}, HTTP_OK)
      })

      await harness.callRequest('get', '/devices')
      vi.useRealTimers()

      expect(onRequestComplete).toHaveBeenCalledWith(
        expect.objectContaining({ durationMs: 0 }),
      )
    })
  })

  describe('resilience rungs', () => {
    it('replays a GET once after a successful reactive re-auth', async () => {
      using harness = new Harness()
      harness.isReauthenticated = true
      respondWith(HTTP_UNAUTHORIZED)
      respondWith(HTTP_OK)

      await expect(harness.callRequest('get', '/devices')).resolves.toBe(
        HTTP_OK,
      )

      expect(harness.seen).toStrictEqual(['reauthenticate'])
    })

    // The same rung when the recovery FAILS. `AuthRetryPolicy` replays
    // on the strength of `reauthenticate()` alone, so a hook that
    // answers `true` over a refused re-sign-in replays the request with
    // the very credential the server just rejected — one
    // guaranteed-auth-failure round-trip against an upstream that may
    // throttle, and the retry guard makes it exactly one, which is how
    // it stayed invisible. Wired as melcloud Classic wires it: its
    // `reauthenticate()` IS `resumeSession`, and it deliberately does
    // not clear first, so the rejected credential is still standing
    // when the verdict is taken.
    it('never replays a 401 when the re-sign-in was refused', async () => {
      const store = withCredentials(createStore())
      using harness = new Harness({ settingManager: store.manager })
      seedSession(harness)
      harness.shouldReauthenticateViaResume = true
      harness.authError = new AuthenticationError('rejected')
      respondWith(HTTP_UNAUTHORIZED)
      respondWith(HTTP_UNAUTHORIZED)

      await expect(harness.callRequest('get', '/devices')).rejects.toThrow(
        'Request failed with status code 401',
      )

      // The rejected round-trip, and nothing after it.
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(harness.seen).toStrictEqual(['reauthenticate', 'doAuthenticate'])
    })

    it('takes the auth-failure statuses the subclass declares', async () => {
      using harness = new Harness(
        {},
        { authFailureStatuses: [HTTP_UNAUTHORIZED, HTTP_BAD_REQUEST] },
      )
      harness.isReauthenticated = true
      respondWith(HTTP_BAD_REQUEST)
      respondWith(HTTP_OK)

      await expect(harness.callRequest('get', '/devices')).resolves.toBe(
        HTTP_OK,
      )
    })

    it('leaves a 400 alone under the default status set', async () => {
      using harness = new Harness()
      harness.isReauthenticated = true
      respondWith(HTTP_BAD_REQUEST)

      await expect(harness.callRequest('get', '/devices')).rejects.toThrow(
        'Request failed with status code 400',
      )

      expect(harness.seen).toStrictEqual([])
    })

    it('retries a transient GET and reports the retry', async () => {
      const logger = createLogger()
      const onRequestRetry = vi.fn<() => void>()
      using harness = new Harness({ events: { onRequestRetry }, logger })
      vi.useFakeTimers()
      respondWith(HTTP_BAD_GATEWAY)
      respondWith(HTTP_OK)

      const pending = harness.callRequest('get', '/devices')
      await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS)

      await expect(pending).resolves.toBe(HTTP_OK)

      vi.useRealTimers()

      expect(onRequestRetry).toHaveBeenCalledTimes(1)
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Transient server error on /devices: retry 1'),
      )
    })

    it('never retries a transient failure on a mutation', async () => {
      using harness = new Harness()
      respondWith(HTTP_BAD_GATEWAY)

      await expect(harness.callRequest('post', '/control')).rejects.toThrow(
        'Request failed with status code 502',
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('arms the rate-limit gate on a 429 and then refuses fast', async () => {
      using harness = new Harness({}, { rateLimitHours: RATE_LIMIT_HOURS })
      respondWith(HTTP_TOO_MANY_REQUESTS)

      await expect(harness.callRequest('post', '/control')).rejects.toThrow(
        'Request failed with status code 429',
      )

      expect(harness.isRateLimited).toBe(true)

      await expect(harness.callRequest('post', '/control')).rejects.toThrow(
        'API requests are on hold for',
      )
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('lets a 429 through untouched when no rung was built', async () => {
      using harness = new Harness()
      respondWith(HTTP_TOO_MANY_REQUESTS)

      await expect(harness.callRequest('post', '/control')).rejects.toThrow(
        'Request failed with status code 429',
      )

      expect(harness.isRateLimited).toBe(false)
    })
  })

  describe('sync cycle', () => {
    it('returns the work verbatim through both array shapes', async () => {
      using harness = new Harness()
      seedSession(harness)
      harness.registry.push('device')

      await expect(harness.fetchMutable()).resolves.toStrictEqual(['device'])
      await expect(harness.fetchReadonly()).resolves.toStrictEqual(['device'])
    })

    it('propagates a failure out of the strict cycle', async () => {
      using harness = new Harness()

      await expect(harness.strictCycle(new Error('boom'))).rejects.toThrow(
        'boom',
      )
    })

    it('downgrades the same failure to an empty list best-effort', async () => {
      const logger = createLogger()
      using harness = new Harness({ logger })
      const error = new Error('boom')

      await expect(harness.bestEffortCycle(error)).resolves.toStrictEqual([])
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to fetch devices:',
        error,
      )
    })

    it('re-applies a sign-out that the cycle raced', async () => {
      using harness = new Harness()
      seedSession(harness)
      harness.registry.push('device')

      const pending = harness.fetchMutable()
      harness.logOut()
      await pending

      expect(harness.registry).toStrictEqual([])
      expect(harness.isAuthenticated()).toBe(false)
    })

    it('announces the loss when a recoverable cycle ends unauthenticated', async () => {
      const store = withCredentials(createStore())
      const onAuthenticationLost = vi.fn<() => void>()
      using harness = new Harness({
        events: { onAuthenticationLost },
        settingManager: store.manager,
      })

      await harness.fetchMutable()
      await harness.fetchMutable()

      expect(onAuthenticationLost).toHaveBeenCalledTimes(1)
    })

    it('stays silent when an unconfigured instance is probed', async () => {
      const onAuthenticationLost = vi.fn<() => void>()
      using harness = new Harness({ events: { onAuthenticationLost } })

      await harness.fetchMutable()

      expect(onAuthenticationLost).not.toHaveBeenCalled()
    })

    // The two events always alternate: one per loss episode.
    it('announces the recovery once the next cycle is authenticated', async () => {
      const store = withCredentials(createStore())
      const onAuthenticationLost = vi.fn<() => void>()
      const onAuthenticationRestored = vi.fn<() => void>()
      using harness = new Harness({
        events: { onAuthenticationLost, onAuthenticationRestored },
        settingManager: store.manager,
      })

      await harness.fetchMutable()
      seedSession(harness)
      await harness.fetchMutable()
      await harness.fetchMutable()

      expect(onAuthenticationLost).toHaveBeenCalledTimes(1)
      expect(onAuthenticationRestored).toHaveBeenCalledTimes(1)
    })
  })

  describe('disposal', () => {
    it('stops the auto-sync timer', async () => {
      const harness = new Harness({ syncIntervalMinutes: 1 })
      vi.useFakeTimers()
      seedSession(harness)
      await harness.fetchMutable()

      harness[Symbol.dispose]()
      await vi.advanceTimersByTimeAsync(MS_PER_MINUTE)
      vi.useRealTimers()

      expect(harness.seen).not.toContain('autoSync')
    })

    it('releases the retry-guard window', async () => {
      const harness = new Harness()
      respondWith(HTTP_UNAUTHORIZED)

      await expect(harness.callRequest('get', '/devices')).rejects.toThrow(
        'Request failed with status code 401',
      )

      respondWith(HTTP_UNAUTHORIZED)

      await expect(harness.callRequest('get', '/devices')).rejects.toThrow(
        'Request failed with status code 401',
      )

      expect(harness.seen).toStrictEqual(['reauthenticate'])

      harness[Symbol.dispose]()
      respondWith(HTTP_UNAUTHORIZED)

      await expect(harness.callRequest('get', '/devices')).rejects.toThrow(
        'Request failed with status code 401',
      )

      expect(harness.seen).toStrictEqual(['reauthenticate', 'reauthenticate'])
    })
  })
})
