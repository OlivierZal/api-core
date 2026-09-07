import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpClient, HttpError } from '../../src/http/index.ts'
import { Temporal } from '../../src/temporal.ts'
import {
  cast,
  createHttpError,
  createLogger,
  createMockHttpClient,
  createServerError,
  createSettingStore,
  createUnauthorizedError,
  defined,
  mock,
  mockFetchResponse,
  mockTemporalNowInstant,
  mockTemporalNowZoned,
} from '../../src/testing/index.ts'

// The helpers ship to the consumers' suites through the `./testing`
// subpath, so their contract is pinned here the way a consumer relies
// on it — including the `Response` constructor's null-body statuses,
// which every SDK suite used to guard by hand.

const FROZEN = '2026-03-01T12:00:00Z'
const ONE_SECOND_MS = 1000

const HTTP_OK = 200
const HTTP_NO_CONTENT = 204
const HTTP_RESET_CONTENT = 205
const HTTP_NOT_MODIFIED = 304
const HTTP_UNAUTHORIZED = 401
const HTTP_SERVER_ERROR = 500
const HTTP_BAD_GATEWAY = 502

// An SDK's thin transport subclass, standing in for the class each SDK
// passes so the helper hands back its own type.
class VendorHttpClient extends HttpClient {}

describe(cast, () => {
  it('hands the value back untouched', () => {
    const value = { partial: true }

    expect(cast(value)).toBe(value)
  })
})

describe(mock, () => {
  it('hands the overrides back as the full type', () => {
    const overrides = { name: 'partial' }

    expect(mock<{ name: string; other: number }>(overrides)).toBe(overrides)
  })

  it('defaults to an empty double', () => {
    expect(mock<{ name: string }>()).toStrictEqual({})
  })
})

describe(defined, () => {
  it('returns a present value', () => {
    expect(defined('present')).toBe('present')
    expect(defined(0)).toBe(0)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('throws on %s', (_name, value) => {
    expect(() => defined(value)).toThrow('Expected value to be defined')
  })
})

describe(createLogger, () => {
  it('builds a logger whose channels record their calls', () => {
    const logger = createLogger()

    logger.log('info', 1)
    logger.error('failure')

    expect(logger.log).toHaveBeenCalledWith('info', 1)
    expect(logger.error).toHaveBeenCalledWith('failure')
  })
})

describe('temporal clock spies', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('routes Temporal.Now.instant through the mocked Date clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Temporal.Instant.from(FROZEN).epochMilliseconds)
    mockTemporalNowInstant()

    expect(Temporal.Now.instant().epochMilliseconds).toBe(Date.now())

    vi.advanceTimersByTime(ONE_SECOND_MS)

    expect(Temporal.Now.instant().toString()).toBe(
      Temporal.Instant.from(FROZEN).add({ seconds: 1 }).toString(),
    )
  })

  it('routes Temporal.Now.zonedDateTimeISO through the mocked Date clock in the requested zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Temporal.Instant.from(FROZEN).epochMilliseconds)
    mockTemporalNowZoned()

    const zoned = Temporal.Now.zonedDateTimeISO('Europe/Paris')

    expect(zoned.epochMilliseconds).toBe(Date.now())
    expect(zoned.timeZoneId).toBe('Europe/Paris')
  })

  it('defaults the zoned read to UTC when no zone is named', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Temporal.Instant.from(FROZEN).epochMilliseconds)
    mockTemporalNowZoned()

    expect(Temporal.Now.zonedDateTimeISO().timeZoneId).toBe('UTC')
  })
})

describe(mockFetchResponse, () => {
  it('serialises an object body as JSON and labels it so', async () => {
    const response = mockFetchResponse({ ok: true })

    expect(response.status).toBe(HTTP_OK)
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toStrictEqual({ ok: true })
  })

  it('keeps an explicit content-type over the JSON default', async () => {
    const response = mockFetchResponse(
      { ok: true },
      { 'content-type': 'text/plain' },
    )

    expect(response.headers.get('content-type')).toBe('text/plain')
    await expect(response.text()).resolves.toBe('{"ok":true}')
  })

  // A string body gets the `Response` constructor's own default
  // (`text/plain;charset=UTF-8`, per the Fetch spec), not the helper's
  // JSON label.
  it('passes a string body through under the platform text default', async () => {
    const response = mockFetchResponse('raw')

    expect(response.headers.get('content-type')).toContain('text/plain')
    await expect(response.text()).resolves.toBe('raw')
  })

  it('serialises a null body without the JSON label', async () => {
    const response = mockFetchResponse(null)

    expect(response.headers.get('content-type')).toContain('text/plain')
    await expect(response.text()).resolves.toBe('null')
  })

  it('appends every value of an array header', () => {
    const response = mockFetchResponse({}, { 'set-cookie': ['a=1', 'b=2'] })

    expect(response.headers.getSetCookie()).toStrictEqual(['a=1', 'b=2'])
  })

  it('reports a failing status as not ok, body intact', async () => {
    const response = mockFetchResponse({ error: 'x' }, {}, HTTP_SERVER_ERROR)

    expect(response.ok).toBe(false)
    await expect(response.json()).resolves.toStrictEqual({ error: 'x' })
  })

  it.each([HTTP_NO_CONTENT, HTTP_RESET_CONTENT, HTTP_NOT_MODIFIED])(
    'builds a null body on the null-body status %i',
    (status) => {
      const response = mockFetchResponse({ ignored: true }, {}, status)

      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
    },
  )
})

describe('httpError factories', () => {
  it('createHttpError defaults the method and the response headers', () => {
    const error = createHttpError({
      message: 'boom',
      status: HTTP_SERVER_ERROR,
      url: '/boom',
    })

    expect(error).toBeInstanceOf(HttpError)
    expect(error.message).toBe('boom')
    expect(error.config).toStrictEqual({ method: 'get', url: '/boom' })
    expect(error.response).toStrictEqual({
      data: {},
      headers: {},
      status: HTTP_SERVER_ERROR,
    })
  })

  it('createHttpError carries an explicit method and response headers', () => {
    const error = createHttpError({
      message: 'boom',
      method: 'post',
      responseHeaders: { 'retry-after': '30' },
      status: HTTP_SERVER_ERROR,
      url: '/boom',
    })

    expect(error.config?.method).toBe('post')
    expect(error.response.headers).toStrictEqual({ 'retry-after': '30' })
  })

  it('createServerError names the status and defaults the url', () => {
    const error = createServerError(HTTP_BAD_GATEWAY)

    expect(error.message).toBe('Status 502')
    expect(error.response.status).toBe(HTTP_BAD_GATEWAY)
    expect(error.config?.url).toBe('/test')
    expect(createServerError(HTTP_BAD_GATEWAY, '/other').config?.url).toBe(
      '/other',
    )
  })

  it('createUnauthorizedError builds a 401 and defaults the url', () => {
    const error = createUnauthorizedError()

    expect(error.message).toBe('Unauthorized')
    expect(error.response.status).toBe(HTTP_UNAUTHORIZED)
    expect(error.config?.url).toBe('/test')
    expect(createUnauthorizedError('/login').config?.url).toBe('/login')
  })
})

describe(createSettingStore, () => {
  it('reads the seeded entries and null for the rest', () => {
    const { settingManager } = createSettingStore({ username: 'user' })

    expect(settingManager.get('username')).toBe('user')
    expect(settingManager.get('password')).toBeNull()
  })

  it('records writes on the spy and stores them', () => {
    const { setSpy, settingManager } = createSettingStore()

    settingManager.set('token', 'abc')

    expect(setSpy).toHaveBeenCalledWith('token', 'abc')
    expect(settingManager.get('token')).toBe('abc')
  })

  it('delegates no unset unless asked', () => {
    const { settingManager } = createSettingStore()

    expect(settingManager.unset).toBeUndefined()
  })

  it('delegates unset on request, recording the deletion', () => {
    const { settingManager, unsetSpy } = createSettingStore(
      { token: 'abc' },
      { hasUnset: true },
    )

    settingManager.unset?.('token')

    expect(unsetSpy).toHaveBeenCalledWith('token')
    expect(settingManager.get('token')).toBeNull()
  })
})

describe(createMockHttpClient, () => {
  it('instantiates the class handed over and spies on its request', async () => {
    const { client, requestSpy } = createMockHttpClient(
      VendorHttpClient,
      'https://vendor.test',
    )
    requestSpy.mockResolvedValue({ data: 'x', headers: {}, status: HTTP_OK })

    const response = await client.request({ url: '/x' })

    expect(client).toBeInstanceOf(VendorHttpClient)
    expect(requestSpy).toHaveBeenCalledWith({ url: '/x' })
    expect(response.data).toBe('x')
  })
})
