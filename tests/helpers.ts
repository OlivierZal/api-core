import { vi } from 'vitest'

import type { Logger } from '../src/api/index.ts'
import { HttpError } from '../src/http/index.ts'
import { Temporal } from '../src/temporal.ts'

// Deliberate type-breach boundary — and the suite's only one: call
// sites hand over values the compiled types rightly refuse (partial
// doubles standing in for rich runtime records) because that refusal
// is the behavior under test. Prefer an honest shape where one exists
// (a typed `vi.fn` signature, a zod parse); reach for `cast` only when
// the type error is the point.
export function cast(value: unknown): never
export function cast(value: unknown): unknown {
  return value
}

// `temporal-polyfill` v1 delegates to the native `Temporal` when the
// runtime ships one (Node 26+). Native `Temporal.Now` reads the real
// clock directly, bypassing `vi.setSystemTime` (which only patches
// `Date`), so tests that freeze or advance time must also route
// `Temporal.Now.instant()` through the mocked `Date.now()`. Under the
// polyfilled implementation this spy is a behavioral no-op. Restore it
// with `vi.mocked(Temporal.Now.instant).mockRestore()` next to
// `vi.useRealTimers()`.
export const mockTemporalNowInstant = (): void => {
  vi.spyOn(Temporal.Now, 'instant').mockImplementation(() =>
    Temporal.Instant.fromEpochMilliseconds(Date.now()),
  )
}

export const defined = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

const HTTP_OK = 200

export const createLogger = (): Logger => ({
  error: vi.fn<(...data: unknown[]) => void>(),
  log: vi.fn<(...data: unknown[]) => void>(),
})

// The Response constructor rejects a non-null body on the Fetch spec's
// "null body" statuses; 204 is the only one the suite produces.
const HTTP_NO_CONTENT = 204

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

const serializeBody = (body: unknown): string => {
  if (typeof body === 'string') {
    return body
  }
  return JSON.stringify(body)
}

/**
 * Build a fetch-compatible Response mock covering the surface
 * `HttpClient.request` relies on: `.status`, `.ok`, `.text()`,
 * `.headers.get()`, and `.headers.getSetCookie()`.
 * @param body - Response body; objects are JSON-serialised, strings pass
 *   through.
 * @param headers - Response headers; `set-cookie` may be an array.
 * @param status - Response status (defaults to 200).
 * @returns A minimal `Response` object sufficient for the client tests.
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
  return new Response(status === HTTP_NO_CONTENT ? null : serializeBody(body), {
    headers: responseHeaders,
    status,
  })
}

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

export const createServerError = (status: number, url = '/test'): HttpError =>
  createHttpError({ message: `Status ${String(status)}`, status, url })

export const createUnauthorizedError = (url = '/test'): HttpError =>
  createHttpError({ message: 'Unauthorized', status: 401, url })
