import { describe, expect, it } from 'vitest'

import {
  BASE_SENSITIVE_KEYS,
  baseRedaction,
  createRedaction,
  REDACTED,
} from '../../src/observability/redaction.ts'

// Every reader of a redacted form-encoded body parses it, so the helper
// hands back the parsed params rather than the string each caller wrapped.
const asParams = (value: unknown): URLSearchParams => {
  if (typeof value !== 'string') {
    throw new TypeError('expected a string')
  }
  return new URLSearchParams(value)
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

  // The personal-data tier (api-core#50): a `/context` body names every
  // unit by the string its owner typed, the dumps print whole bodies on
  // purpose, and the core knows no wire's field names — so the SDK
  // declares them apart from its credentials, and the engine blanks
  // them the same way, wherever the key rides.
  it('blanks a declared personal-data key like a credential, in any casing', () => {
    const redaction = createRedaction([], {
      personalDataKeys: ['givenDisplayName'],
    })

    expect(redaction.isSensitive('givenDisplayName')).toBe(true)
    expect(redaction.isSensitive('GIVENDISPLAYNAME')).toBe(true)
    expect(
      redaction.redactValue({
        buildings: [
          {
            airToAirUnits: [{ givenDisplayName: 'Living room', id: 'unit-1' }],
            name: 'Home',
          },
        ],
      }),
    ).toStrictEqual({
      buildings: [
        {
          airToAirUnits: [{ givenDisplayName: REDACTED, id: 'unit-1' }],
          name: 'Home',
        },
      ],
    })
    expect(
      redaction.redactUrl('/rename?givenDisplayName=Living%20room&id=1'),
    ).toBe(`/rename?givenDisplayName=${REDACTED}&id=1`)
  })

  it('keeps the credential tiers whole whatever the personal-data tier holds', () => {
    const redaction = createRedaction(['contextkey'], {
      personalDataKeys: ['dev_alias'],
    })

    expect(redaction.isSensitive('password')).toBe(true)
    expect(redaction.isSensitive('contextkey')).toBe(true)
    expect(redaction.isSensitive('dev_alias')).toBe(true)
    expect(redaction.isSensitive('did')).toBe(false)
  })

  // An SDK that declares no personal data redacts exactly what it did
  // before the tier existed: the option is additive, never a default.
  it.each([
    ['no options bag', createRedaction(['contextkey'])],
    ['an empty options bag', createRedaction(['contextkey'], {})],
    [
      'an empty personal-data tier',
      createRedaction(['contextkey'], { personalDataKeys: [] }),
    ],
  ])('leaves a personal-data key verbatim with %s', (_name, redaction) => {
    expect(redaction.isSensitive('givenDisplayName')).toBe(false)
    expect(
      redaction.redactValue({
        ContextKey: 'secret',
        givenDisplayName: 'Living room',
      }),
    ).toStrictEqual({ ContextKey: REDACTED, givenDisplayName: 'Living room' })
  })

  // One word can name a person's entry in one object and a wire's own
  // label in another: MELCloud spells an account holder, a building and
  // a device SETTING `name`. A key is blanked wherever it rides, so the
  // SDK declares the word personal and names the one seat where it is
  // not — the enclosing key the objects sit under, arrays aside.
  describe('a personal-data key that names something else under one parent', () => {
    const redaction = createRedaction(['contextkey'], {
      notPersonalUnder: { settings: ['name'] },
      personalDataKeys: ['name'],
    })

    it('keeps the key under the declared parent and blanks it everywhere else', () => {
      expect(
        redaction.redactValue({
          buildings: [
            {
              name: 'Home',
              units: [
                {
                  id: 'unit-1',
                  settings: [
                    { name: 'Power', value: 'True' },
                    { name: 'OperationMode', value: 'Heat' },
                  ],
                },
              ],
            },
          ],
          LoginData: { ContextKey: 'secret', Name: 'Jane Doe' },
        }),
      ).toStrictEqual({
        buildings: [
          {
            name: REDACTED,
            units: [
              {
                id: 'unit-1',
                settings: [
                  { name: 'Power', value: 'True' },
                  { name: 'OperationMode', value: 'Heat' },
                ],
              },
            ],
          },
        ],
        LoginData: { ContextKey: REDACTED, Name: REDACTED },
      })
    })

    it('matches the parent and the key in any casing', () => {
      expect(
        redaction.redactValue({ Settings: [{ NAME: 'Power' }] }),
      ).toStrictEqual({ Settings: [{ NAME: 'Power' }] })
    })

    it('reads the NEAREST enclosing key, not an ancestor', () => {
      expect(
        redaction.redactValue({
          settings: [{ name: 'Power', owner: { name: 'Jane Doe' } }],
        }),
      ).toStrictEqual({
        settings: [{ name: 'Power', owner: { name: REDACTED } }],
      })
    })

    it('blanks the key at the root of a payload, where nothing encloses it', () => {
      expect(redaction.redactValue([{ ID: 1, Name: 'Home' }])).toStrictEqual([
        { ID: 1, Name: REDACTED },
      ])
    })

    it('carries the enclosing key into JSON text riding under it', () => {
      expect(
        redaction.redactValue({
          settings: '[{"name":"Power"}]',
          user: '{"name":"Jane Doe"}',
        }),
      ).toStrictEqual({
        settings: '[{"name":"Power"}]',
        user: '{"name":"******"}',
      })
    })

    // The flat seats know no enclosing key: a header, a query pair or a
    // form-encoded pair named like the key is the personal reading.
    it('keeps the flat seats on the personal reading', () => {
      expect(redaction.isSensitive('name')).toBe(true)
      expect(redaction.redactUrl('/rename?name=Home&id=1')).toBe(
        `/rename?name=${REDACTED}&id=1`,
      )
      expect(
        redaction.redactValue({ settings: 'name=Home&id=1' }),
      ).toStrictEqual({ settings: `name=${REDACTED}&id=1` })
    })
  })

  // An exemption is a statement about a PERSONAL key. One that names a
  // credential would be a way to print a secret, and one that names a
  // key the tier does not hold does nothing while reading as if it did:
  // both are refused when the engine is built, where a suite sees them.
  it.each([
    ['a base credential key', { settings: ['password'] }, 'password'],
    ['an injected credential key', { settings: ['ContextKey'] }, 'ContextKey'],
    ['a key the personal tier does not hold', { settings: ['label'] }, 'label'],
  ])('refuses an exemption that names %s', (_name, notPersonalUnder, key) => {
    expect(() =>
      createRedaction(['contextkey'], {
        notPersonalUnder,
        personalDataKeys: ['name', 'password'],
      }),
    ).toThrow(
      new TypeError(
        `\`${key}\` cannot be exempted under \`settings\`: only a declared personal-data key that names no credential can`,
      ),
    )
  })

  // A parent is matched in any casing, like a key: two spellings of one
  // parent are one seat, and their exemptions add up. Keyed on the
  // lower-cased parent, the second used to REPLACE the first, so which
  // exemption survived depended on the order they were written in.
  it('adds up the exemptions of a parent spelled in two casings', () => {
    const redaction = createRedaction([], {
      notPersonalUnder: { Settings: ['label'], settings: ['name'] },
      personalDataKeys: ['label', 'name'],
    })

    expect(
      redaction.redactValue({
        label: 'Kitchen',
        settings: [{ label: 'Mode', name: 'Power' }],
      }),
    ).toStrictEqual({
      label: REDACTED,
      settings: [{ label: 'Mode', name: 'Power' }],
    })
  })

  // A parent that is itself blanked is replaced whole: nothing under it
  // is ever walked, so an exemption there does nothing while reading as
  // if it did.
  it.each([
    ['a personal-data key', 'owner'],
    ['a credential key', 'Token'],
  ])('refuses an exemption under a parent that is %s', (_name, parent) => {
    expect(() =>
      createRedaction([], {
        notPersonalUnder: { [parent]: ['name'] },
        personalDataKeys: ['name', 'owner'],
      }),
    ).toThrow(
      new TypeError(
        `Nothing can be exempted under \`${parent}\`: the key is blanked whole, what it holds is never read`,
      ),
    )
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
    const params = asParams(
      baseRedaction.redactValue(
        'csrf=tok&password=s3cret&username=user%40example.com&extra=visible',
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
    const params = asParams(
      baseRedaction.redactValue('password=one&password=two&after=kept'),
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
