/**
 * The vitest-backed helpers every consuming SDK's suite carried as a
 * hand-maintained twin of this package's own — the type-breach and
 * partial-double boundaries, the logger and setting-store doubles, the
 * transport spy, the fetch `Response` mock, the `HttpError` factories
 * and the native-`Temporal` clock spies. It runs inside the consumer's
 * vitest process: `vitest` is imported here and declared nowhere,
 * because the SDKs install this package as a PRODUCTION dependency of
 * the Homey apps, and a peer — optional or not — would put the test
 * framework on the device. The root barrel never re-exports this
 * module for the same reason.
 * @packageDocumentation
 */
import { type Mock, type MockInstance, vi } from 'vitest'

import type { Logger, SettingManager } from '../api/types.ts'
import type {
  HttpClient,
  HttpClientConfig,
  HttpRequestConfig,
  HttpResponse,
} from '../http/client.ts'
import { HttpError } from '../http/errors.ts'
import { Temporal } from '../temporal.ts'

const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401

// The Fetch spec's "null body" statuses the `Response` constructor can
// be asked to build — it refuses a non-null body on them. 101 and 103
// complete the spec's set but sit outside the 200–599 range the
// constructor admits at all (measured on Node 26.7), so no helper can
// stage them and listing them would be dead data.
const HTTP_NO_CONTENT = 204
const HTTP_RESET_CONTENT = 205
const HTTP_NOT_MODIFIED = 304
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([
  HTTP_NO_CONTENT,
  HTTP_NOT_MODIFIED,
  HTTP_RESET_CONTENT,
])

// The transport timeout every SDK suite wires; nothing in a unit suite
// waits on it.
const MOCK_TIMEOUT_MS = 30_000

/**
 * A transport and the spy on its `request`, as
 * {@link createMockHttpClient} builds them.
 * @template TClient - The transport class under test.
 * @category Testing
 */
export interface MockHttpClient<TClient extends HttpClient> {
  /**
   * The transport instance, of the class handed over.
   */
  readonly client: TClient
  /**
   * The spy on the transport's `request`: stub it, then assert on its
   * calls. Spelled as the method's own signature rather than
   * `HttpClient['request']`, so the docs do not inherit the method's
   * comment into a module that cannot resolve its links.
   */
  readonly requestSpy: MockInstance<
    <T = unknown>(config: HttpRequestConfig) => Promise<HttpResponse<T>>
  >
}

/**
 * An in-memory `SettingManager` and the spies on its writes, as
 * {@link createSettingStore} builds them.
 * @category Testing
 */
export interface SettingStore {
  /**
   * The spy behind the manager's `set`.
   */
  readonly setSpy: Mock<(key: string, value: string) => void>
  /**
   * The manager, over the seeded map.
   */
  readonly settingManager: SettingManager
  /**
   * The spy behind the manager's `unset` — wired only on request.
   */
  readonly unsetSpy: Mock<(key: string) => void>
}

/**
 * The deliberate type-breach boundary — and a suite's only one: call
 * sites hand over values the compiled types rightly refuse (wire
 * payloads carrying fields the schema forbids, partial doubles standing
 * in for rich runtime records) because that refusal is the behavior
 * under test. Prefer an honest shape where one exists ({@link mock}, a
 * typed `vi.fn` signature, a zod parse); reach for `cast` only when the
 * type error is the point. The value comes back untouched, typed
 * `never` so it is assignable anywhere.
 * @param value - The value to hand over untyped.
 * @category Testing
 */
export function cast(value: unknown): never
export function cast(value: unknown): unknown {
  return value
}

/**
 * The partial-double boundary: hands the overrides back as the full
 * type, so a test names the members it exercises and nothing else.
 * @template T - The full type the double stands in for.
 * @param value - The members the test exercises.
 * @returns The same object, typed as the full `T`.
 * @category Testing
 */
export function mock<T extends object>(value?: Partial<T>): T
export function mock(value: unknown = {}): unknown {
  return value
}

/**
 * Narrows a possibly-absent value, throwing where it is absent.
 * @template T - The present type.
 * @param value - The value to narrow.
 * @returns The value, present.
 * @throws An `Error` when the value is `null` or `undefined`.
 * @category Testing
 */
export const defined = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

/**
 * A {@link Logger} whose two channels are vitest mocks.
 * @returns The logger double.
 * @category Testing
 */
export const createLogger = (): Logger => ({
  error: vi.fn<(...data: unknown[]) => void>(),
  log: vi.fn<(...data: unknown[]) => void>(),
})

/**
 * Routes `Temporal.Now.instant()` through the mocked `Date.now()`.
 * `temporal-polyfill` v1 captures the native `Temporal` at import time
 * when the runtime ships one (Node 26+); vitest 5's fake timers swap
 * `globalThis.Temporal` for a clock-backed copy, which that captured
 * reference never sees, so native `Temporal.Now` keeps reading the real
 * clock — a test that freezes or advances time must also route the
 * instant through the mocked clock. Under the polyfilled implementation
 * the spy is a behavioral no-op. Restore it with
 * `vi.mocked(Temporal.Now.instant).mockRestore()` next to
 * `vi.useRealTimers()`.
 * @category Testing
 */
export const mockTemporalNowInstant = (): void => {
  vi.spyOn(Temporal.Now, 'instant').mockImplementation(() =>
    Temporal.Instant.fromEpochMilliseconds(Date.now()),
  )
}

/**
 * The zoned twin of {@link mockTemporalNowInstant}, for the
 * `Temporal.Now.zonedDateTimeISO()` reads a consumer anchors its
 * zone-aware windows on. Restore it with
 * `vi.mocked(Temporal.Now.zonedDateTimeISO).mockRestore()` next to
 * `vi.useRealTimers()`.
 * @category Testing
 */
export const mockTemporalNowZoned = (): void => {
  vi.spyOn(Temporal.Now, 'zonedDateTimeISO').mockImplementation((timezone) =>
    Temporal.Instant.fromEpochMilliseconds(Date.now()).toZonedDateTimeISO(
      timezone ?? 'UTC',
    ),
  )
}

const buildMockHeaders = (
  headers: Record<string, string | string[]>,
): Headers => {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item)
      }
    } else {
      result.set(key, value)
    }
  }
  return result
}

const serializeBody = (body: unknown): string =>
  typeof body === 'string' ? body : JSON.stringify(body)

/**
 * Build a fetch-compatible `Response` covering the surface
 * `HttpClient.request` relies on: `.status`, `.ok`, `.text()` (through
 * `parseBody`), and — through `readHeaders` — `.headers.entries()` and
 * `.headers.getSetCookie()`. Nothing in the client reads
 * `.headers.get()`. A null-body status (204, 205, 304) gets the `null`
 * body the `Response` constructor insists on.
 * @param body - Response body; objects are JSON-serialised (and default
 * the `content-type` to JSON), strings pass through.
 * @param headers - Response headers; `set-cookie` may be an array.
 * @param status - Response status (defaults to 200).
 * @returns A `Response` sufficient for the transport tests.
 * @category Testing
 */
export const mockFetchResponse = (
  body: unknown,
  headers: Record<string, string | string[]> = {},
  status: number = HTTP_OK,
): Response => {
  const responseHeaders = buildMockHeaders(headers)
  if (
    typeof body === 'object' &&
    body !== null &&
    !responseHeaders.has('content-type')
  ) {
    responseHeaders.set('content-type', 'application/json')
  }
  return new Response(
    NULL_BODY_STATUSES.has(status) ? null : serializeBody(body),
    { headers: responseHeaders, status },
  )
}

/**
 * An {@link HttpError} carrying a minimal request snapshot and an empty
 * response body — the shape the resilience policies and the session
 * mechanism branch on.
 * @param root0 - The error's coordinates.
 * @param root0.message - Human-readable error description.
 * @param root0.method - Request method (defaults to `get`).
 * @param root0.responseHeaders - Response headers (default none).
 * @param root0.status - Response status.
 * @param root0.url - Request URL.
 * @returns The built error, its snapshot redacted through the base
 * vocabulary like any other.
 * @category Testing
 */
export const createHttpError = ({
  message,
  method = 'get',
  responseHeaders = {},
  status,
  url,
}: {
  message: string
  status: number
  url: string
  method?: string
  responseHeaders?: Record<string, string>
}): HttpError =>
  new HttpError(message, {
    config: { method, url },
    response: { data: {}, headers: responseHeaders, status },
  })

/**
 * An {@link HttpError} for a server-side status, messaged
 * `Status <code>`.
 * @param status - Response status.
 * @param url - Request URL (defaults to `/test`).
 * @returns The built error, status and url as given.
 * @category Testing
 */
export const createServerError = (status: number, url = '/test'): HttpError =>
  createHttpError({ message: `Status ${String(status)}`, status, url })

/**
 * An {@link HttpError} for a `401`, messaged `Unauthorized`.
 * @param url - Request URL (defaults to `/test`).
 * @returns The built 401, url as given.
 * @category Testing
 */
export const createUnauthorizedError = (url = '/test'): HttpError =>
  createHttpError({ message: 'Unauthorized', status: HTTP_UNAUTHORIZED, url })

/**
 * An in-memory {@link SettingManager} over a seeded map, with spies on
 * its writes. `unset` is delegated only on request, so a suite can
 * model both host shapes the `setting` decorator distinguishes.
 * @param initial - The seeded entries.
 * @param root1 - Options.
 * @param root1.hasUnset - Whether the manager delegates `unset` (defaults to `false`).
 * @returns The manager and its two write spies.
 * @category Testing
 */
export const createSettingStore = (
  initial: Record<string, string> = {},
  { hasUnset = false }: { hasUnset?: boolean } = {},
): SettingStore => {
  const store = new Map(Object.entries(initial))
  const setSpy = vi.fn<(key: string, value: string) => void>((key, value) => {
    store.set(key, value)
  })
  const unsetSpy = vi.fn<(key: string) => void>((key) => {
    store.delete(key)
  })
  return {
    setSpy,
    settingManager: {
      set: setSpy,
      get: (key: string) => store.get(key) ?? null,
      ...(hasUnset && { unset: unsetSpy }),
    },
    unsetSpy,
  }
}

/**
 * Spin up a transport and a vitest spy on its `request` method in one
 * call. The class is a parameter because each SDK's transport is its
 * own thin `HttpClient` subclass — the one seating its redaction
 * vocabulary, and the one its `instanceof` resolver accepts.
 * @template TClient - The transport class under test.
 * @param clientClass - The transport class to instantiate.
 * @param baseURL - Base URL the transport is pinned to.
 * @returns The wired client and a spy on its `request`.
 * @category Testing
 */
export const createMockHttpClient = <TClient extends HttpClient>(
  clientClass: new (config: HttpClientConfig) => TClient,
  baseURL: string,
): MockHttpClient<TClient> => {
  const client = new clientClass({ baseURL, timeout: MOCK_TIMEOUT_MS })
  const transport: HttpClient = client
  return { client, requestSpy: vi.spyOn(transport, 'request') }
}
