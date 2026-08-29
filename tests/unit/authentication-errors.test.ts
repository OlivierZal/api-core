import { describe, expect, it } from 'vitest'

import {
  APIError,
  AuthenticationError,
  AuthenticationThrottledError,
  isAPIError,
} from '../../src/errors/index.ts'
import { Temporal } from '../../src/temporal.ts'

describe.concurrent('authenticationError', () => {
  it('is an APIError and an Error', () => {
    const error = new AuthenticationError('bad credentials')

    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error).toBeInstanceOf(APIError)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('bad credentials')
    expect(error.name).toBe('AuthenticationError')
  })

  it('carries the cause through the standard chain', () => {
    const cause = new Error('401')
    const error = new AuthenticationError('wrapped', { cause })

    expect(error.cause).toBe(cause)
  })

  it('is caught by the family guard', () => {
    const error: unknown = new AuthenticationError('x')

    expect(isAPIError(error)).toBe(true)
  })

  // The class is concrete, not abstract: a consuming SDK throws it
  // directly rather than deriving a name-only subclass.
  it('names itself even with no subclass in play', () => {
    const error: APIError = new AuthenticationError('x')

    expect(error.name).toBe('AuthenticationError')
  })
})

describe.concurrent('authenticationThrottledError', () => {
  it('extends AuthenticationError, so a login-failure catch still holds', () => {
    const error = new AuthenticationThrottledError('locked out')

    expect(error).toBeInstanceOf(AuthenticationThrottledError)
    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error).toBeInstanceOf(APIError)
    expect(isAPIError(error)).toBe(true)
  })

  it('narrows the inherited name to its own', () => {
    const error = new AuthenticationThrottledError('locked out')

    expect(error.name).toBe('AuthenticationThrottledError')
    expect(error.message).toBe('locked out')
  })

  it('carries the announced retryAfter window', () => {
    const retryAfter = Temporal.Duration.from({ minutes: 15 })
    const error = new AuthenticationThrottledError('locked out', { retryAfter })

    expect(error.retryAfter?.total({ unit: 'minutes' })).toBe(15)
  })

  it.each([
    ['no options at all', undefined],
    ['an options bag without the field', {}],
    ['an explicit null', { retryAfter: null }],
  ])('defaults retryAfter to null given %s', (_label, options) => {
    const error = new AuthenticationThrottledError('locked out', options)

    expect(error.retryAfter).toBeNull()
  })

  it('preserves the cause alongside the window', () => {
    const cause = new Error('ErrorId 6')
    const error = new AuthenticationThrottledError('locked out', {
      cause,
      retryAfter: Temporal.Duration.from({ seconds: 30 }),
    })

    expect(error.cause).toBe(cause)
    expect(error.retryAfter?.total({ unit: 'seconds' })).toBe(30)
  })

  // The distinction the coming session mechanism gates its backoff on:
  // a throttle is not a rejected password.
  it('is distinguishable from a plain AuthenticationError', () => {
    const plain: AuthenticationError = new AuthenticationError('bad password')
    const throttled: AuthenticationError = new AuthenticationThrottledError(
      'locked out',
    )

    expect(plain).not.toBeInstanceOf(AuthenticationThrottledError)
    expect(throttled).toBeInstanceOf(AuthenticationThrottledError)
  })
})
