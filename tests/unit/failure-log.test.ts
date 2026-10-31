import { describe, expect, it } from 'vitest'

import {
  AuthenticationError,
  RegistrySyncError,
  ValidationError,
} from '../../src/errors/index.ts'
import { HttpError } from '../../src/http/index.ts'
import {
  failureCauseChain,
  isKnownFailure,
  logFailure,
} from '../../src/observability/failure-log.ts'
import { createLogger, createServerError } from '../../src/testing/index.ts'

const TIMEOUT_MESSAGE = 'The operation was aborted due to timeout'

const LABEL = 'Failed to fetch devices:'

// The client's own budget, as `AbortSignal.timeout` fires it: a
// `DOMException` whose legacy `code` is a number (23).
const timeoutError = (): DOMException =>
  new DOMException(TIMEOUT_MESSAGE, 'TimeoutError')

// What undici throws over a connect timeout: the detail one level down,
// identified by its string `code`.
const fetchFailed = (): TypeError =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  })

// The client's fence around the dialect's failure reader: the status
// line stands in for the message, and the reader's own throw rides
// `cause`.
const readerFailed = (): HttpError =>
  new HttpError('Request failed with status code 500', {
    cause: new TypeError('describeFailure bug'),
    response: { data: {}, headers: {}, status: 500 },
  })

// A zod 4 `ZodError`, as `instanceof Error` sees it: its message is the
// issue list, pretty-printed over many lines.
class ZodError extends Error {
  public override readonly name = 'ZodError'
}

const zodError = (): Error =>
  new ZodError(
    '[\n  {\n    "code": "invalid_type",\n    "path": [\n      "Devices"\n    ]\n  }\n]',
  )

const FETCH_FAILED_CHAIN =
  'TypeError: fetch failed — caused by Error: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)'

describe(isKnownFailure, () => {
  it.each([
    ['an HttpError', createServerError(503)],
    ['a refused credential', new AuthenticationError('rejected')],
    ['a validation failure', new ValidationError('refused', { context: 'x' })],
    ["undici's fetch failed", new TypeError('fetch failed')],
    ['the client timeout', timeoutError()],
    ['a caller abort', new DOMException('aborted', 'AbortError')],
    [
      'a wrapped HttpError',
      new Error('wrapped', { cause: createServerError(500) }),
    ],
    [
      'a registry sync failure over a refused payload',
      new RegistrySyncError('stale', { cause: createServerError(500) }),
    ],
    [
      'a registry sync failure over a transport failure',
      new RegistrySyncError('stale', { cause: fetchFailed() }),
    ],
  ])('knows %s', (_name, error) => {
    expect(isKnownFailure(error)).toBe(true)
  })

  // A wrapper is judged by what it wraps: the verdict's type adds
  // nothing to a bug's location, and the stack under its cause is it.
  it.each([
    ['a plain error', new Error('boom')],
    ['another TypeError', new TypeError('x is not a function')],
    ['a RangeError', new RangeError('out of range')],
    ['a string', 'offline'],
    ['undefined', undefined],
    ['a plain object', { code: 'ECONNRESET' }],
    [
      'a registry sync failure over a programming error',
      new RegistrySyncError('stale', {
        cause: new TypeError(
          "Cannot read properties of undefined (reading 'Devices')",
        ),
      }),
    ],
    ["an HttpError carrying its reader's failure", readerFailed()],
  ])('does not know %s', (_name, error) => {
    expect(isKnownFailure(error)).toBe(false)
  })
})

describe(failureCauseChain, () => {
  it('spells a bare error by its name and message', () => {
    expect(failureCauseChain(new Error('boom'))).toBe('Error: boom')
  })

  it('spells the chain outermost first, each link with its string code', () => {
    expect(failureCauseChain(fetchFailed())).toBe(FETCH_FAILED_CHAIN)
  })

  it('leaves a numeric code out', () => {
    expect(failureCauseChain(timeoutError())).toBe(
      `TimeoutError: ${TIMEOUT_MESSAGE}`,
    )
  })

  // Plain objects, since a built-in error's `cause` is not reassigned:
  // each spelled by its type and code, the loop closed after one pass.
  it('walks a cycle once', () => {
    const first: { code: string; cause?: object } = { code: 'FIRST' }
    const second = { cause: first, code: 'SECOND' }
    first.cause = second

    expect(failureCauseChain(first)).toBe(
      'a thrown object (FIRST) — caused by a thrown object (SECOND)',
    )
  })

  it('spells a thrown primitive by its value', () => {
    expect(failureCauseChain('offline')).toBe('offline')
  })

  // An object link says nothing under default stringification, and
  // walking its fields could print a credential: its type and its code.
  it('spells a plain-object link by its type and code alone', () => {
    const error = new Error('wrapped', {
      cause: { code: 'ECONNRESET', detail: 'secret' },
    })

    expect(failureCauseChain(error)).toBe(
      'Error: wrapped — caused by a thrown object (ECONNRESET)',
    )
  })

  // A registry payload refusing its schema is the cycle failure the
  // validator spells over a dozen lines: the entry a report counts is
  // still one.
  it('folds a link whose message spans lines onto the one line', () => {
    const error = new ValidationError('refused', {
      cause: zodError(),
      context: 'x',
    })

    expect(failureCauseChain(error)).toBe(
      'ValidationError: refused — caused by ZodError: [ { "code": "invalid_type", "path": [ "Devices" ] } ]',
    )
  })
})

describe(logFailure, () => {
  it('writes a known failure as one line naming its cause chain', () => {
    const logger = createLogger()

    logFailure(logger, LABEL, fetchFailed())

    expect(logger.error).toHaveBeenCalledWith(`${LABEL} ${FETCH_FAILED_CHAIN}`)
  })

  it('writes anything else as the label and the error object', () => {
    const logger = createLogger()
    const error = new Error('boom')

    logFailure(logger, LABEL, error)

    expect(logger.error).toHaveBeenCalledWith(LABEL, error)
  })
})
