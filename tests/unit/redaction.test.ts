import { describe, expect, it } from 'vitest'

import {
  BASE_SENSITIVE_KEYS,
  baseRedaction,
  createRedaction,
  REDACTED,
} from '../../src/observability/redaction.ts'

const asString = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new TypeError('expected a string')
  }
  return value
}

describe.concurrent(createRedaction, () => {
  it.each([...BASE_SENSITIVE_KEYS])(
    'redacts the base key %s regardless of casing',
    (key) => {
      expect(baseRedaction.isSensitive(key)).toBe(true)
      expect(baseRedaction.isSensitive(key.toUpperCase())).toBe(true)
    },
  )

  it('unions the injected vocabulary with the base one', () => {
    const redaction = createRedaction(['X-Custom-Token'])

    expect(redaction.isSensitive('x-custom-token')).toBe(true)
    expect(redaction.isSensitive('X-CUSTOM-TOKEN')).toBe(true)
    // The base survives the extension.
    expect(redaction.isSensitive('authorization')).toBe(true)
    expect(redaction.isSensitive('x-harmless')).toBe(false)
  })

  it('keeps vocabularies independent between engines', () => {
    const first = createRedaction(['contextkey'])
    const second = createRedaction(['x-gizwits-user-token'])

    expect(first.isSensitive('contextkey')).toBe(true)
    expect(first.isSensitive('x-gizwits-user-token')).toBe(false)
    expect(second.isSensitive('x-gizwits-user-token')).toBe(true)
    expect(second.isSensitive('contextkey')).toBe(false)
  })

  it('redacts injected keys deep inside object payloads', () => {
    const redaction = createRedaction(['contextkey'])

    expect(
      redaction.redactValue({ nested: { ContextKey: 'secret', safe: 'ok' } }),
    ).toStrictEqual({ nested: { ContextKey: REDACTED, safe: 'ok' } })
  })

  it('redacts sensitive keys nested in array payloads', () => {
    expect(
      baseRedaction.redactValue([{ password: 'secret', safe: 'ok' }]),
    ).toStrictEqual([{ password: REDACTED, safe: 'ok' }])
  })

  it('passes primitives through untouched', () => {
    expect(baseRedaction.redactValue(42)).toBe(42)
    expect(baseRedaction.redactValue(null)).toBeNull()
    expect(baseRedaction.redactValue(true)).toBe(true)
  })

  it('redacts sensitive keys inside form-encoded string bodies', () => {
    const params = new URLSearchParams(
      asString(
        baseRedaction.redactValue(
          'csrf=tok&password=s3cret&username=user%40example.com&extra=visible',
        ),
      ),
    )

    expect(params.get('password')).toBe(REDACTED)
    expect(params.get('username')).toBe(REDACTED)
    expect(params.get('csrf')).toBe('tok')
    expect(params.get('extra')).toBe('visible')
  })

  it('redacts every entry of a multi-valued sensitive key while keeping trailing pairs', () => {
    // `URLSearchParams.set()` collapses duplicate entries while the
    // key iterator is live; the redaction loop snapshots keys first so
    // pairs after a duplicated sensitive key are never skipped.
    const params = new URLSearchParams(
      asString(
        baseRedaction.redactValue('password=one&password=two&after=kept'),
      ),
    )

    expect(params.getAll('password')).toStrictEqual([REDACTED])
    expect(params.get('after')).toBe('kept')
  })

  // An upstream can answer a refusal as JSON TEXT (kept raw because a
  // failed body is a diagnostic payload, not a contract); without a
  // JSON attempt in the string branch, a token-bearing field inside
  // that text would ride into every log line verbatim.
  it.each([
    [
      'a token-bearing field',
      '{"error":"invalid_grant","token":"tok-123"}',
      '{"error":"invalid_grant","token":"******"}',
    ],
    [
      'a nested sensitive key',
      '{"outer":{"password":"s3cret","safe":"ok"}}',
      '{"outer":{"password":"******","safe":"ok"}}',
    ],
    ['no secret at all', '{"status":"ok"}', '{"status":"ok"}'],
  ])(
    'redacts JSON-encoded string bodies carrying %s',
    (_name, value, expected) => {
      expect(baseRedaction.redactValue(value)).toBe(expected)
    },
  )

  it('passes through non-sensitive form-encoded strings unchanged', () => {
    expect(baseRedaction.redactValue('page=2&limit=50')).toBe('page=2&limit=50')
  })

  it('does not mutate plain strings that happen to lack `=`', () => {
    expect(baseRedaction.redactValue('just a sentence')).toBe('just a sentence')
  })

  it('redacts the token-bearing query of a URL', () => {
    expect(baseRedaction.redactUrl('/callback?token=auth-code&state=xyz')).toBe(
      `/callback?token=${REDACTED}&state=xyz`,
    )
  })

  it('redacts an injected key riding a URL query', () => {
    const redaction = createRedaction(['code'])

    expect(redaction.redactUrl('/callback?code=auth-code&state=xyz')).toBe(
      `/callback?code=${REDACTED}&state=xyz`,
    )
  })

  it('leaves a URL without a query string verbatim', () => {
    expect(baseRedaction.redactUrl('/Device/Get')).toBe('/Device/Get')
  })

  it('leaves a URL whose query names no secret verbatim', () => {
    expect(baseRedaction.redactUrl('/Device/Get?id=42')).toBe(
      '/Device/Get?id=42',
    )
  })

  it('keeps a `?` inside the query value intact when redacting', () => {
    // `split('?')` fragments are re-joined before the form-encoded
    // pass, so a literal `?` in a value survives.
    expect(baseRedaction.redactUrl('/p?token=a?b&keep=1')).toBe(
      `/p?token=${REDACTED}&keep=1`,
    )
  })
})
