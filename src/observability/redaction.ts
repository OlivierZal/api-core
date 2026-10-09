/**
 * Placeholder written over any value whose key names a secret.
 */
export const REDACTED = '******'

/**
 * The credential keys every consumer redacts, whatever wire it speaks:
 * the generic HTTP carriers plus the account pair every login flow
 * posts. This is the BASE a protocol vocabulary extends through
 * {@link createRedaction} — it is deliberately the intersection of the
 * consuming SDKs' vocabularies, so adopting the core can only ever
 * redact MORE, never less.
 */
export const BASE_SENSITIVE_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'email',
  'password',
  'set-cookie',
  'token',
  'username',
]

/**
 * The redaction engine bound to one sensitive-key vocabulary — the ONE
 * surface shared by the call loggers and the `HttpError` snapshot, so a
 * secret cannot reach a log through either route. Built by
 * {@link createRedaction}; each consumer builds exactly one, seeded
 * with its wire's credential keys.
 */
export interface Redaction {
  /**
   * Whether a header or payload key names a secret — or a personal-data
   * field the SDK declared through {@link RedactionOptions.personalDataKeys}.
   * @param key - Header or payload key, in any casing.
   * @returns `true` when the value behind the key must be redacted.
   */
  readonly isSensitive: (key: string) => boolean
  /**
   * Redacts the query-string portion of a URL through the same
   * form-encoded vocabulary as the bodies: a token can ride inline in
   * the URL (`?code=…`) rather than in a separate `params` record, and
   * the URL travels into every log line and thrown-error snapshot.
   * @param url - Request URL, with or without a query string.
   * @returns The URL with sensitive query values replaced by {@link REDACTED}.
   */
  readonly redactUrl: (url: string) => string
  /**
   * Redacts every value whose key names a secret, walking nested
   * objects, arrays, JSON-encoded and form-encoded strings — the deep
   * counterpart of {@link Redaction.isSensitive}.
   * @param value - Any payload: object, array, string or primitive.
   * @returns The value with sensitive entries replaced by {@link REDACTED}.
   */
  readonly redactValue: (value: unknown) => unknown
}

/**
 * The second vocabulary tier {@link createRedaction} accepts, declared
 * APART from the credential keys because it answers a different rule:
 * a credential must never reach a log because it opens an account; a
 * personal-data field must never reach one because the user typed it,
 * and a diagnostic report pasted into a public issue reproduces it.
 */
export interface RedactionOptions {
  /**
   * User-entered or identifying fields the SDK names on its wire — a
   * device's display name, an account holder's name, a postal address —
   * in any casing. Blanked exactly like a credential wherever they ride
   * (request and response bodies, headers, params, URL queries, the
   * thrown `HttpError` snapshot). The core knows no wire's field names,
   * so this tier is EMPTY unless the SDK fills it, and the credential
   * tier never depends on it: an SDK passing none redacts exactly what
   * it did before.
   */
  readonly personalDataKeys?: Iterable<string> | undefined
}

// JSON text is a string-borne carrier of secrets: an upstream can
// answer a refusal as JSON TEXT (kept raw because a failed body is a
// diagnostic payload, not a contract), and a token-bearing field inside
// it would otherwise pass through verbatim — the form-encoded branch
// alone cannot see it. `undefined` is a safe failure marker: no JSON
// text parses to it.
const parseJsonText = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

type KeySensitivity = (key: string) => boolean

// Detect a string that looks like an `application/x-www-form-urlencoded`
// body and contains at least one sensitive key (e.g. `password=...`).
// Returns the redacted form, or `undefined` when nothing was redacted so
// the caller can keep the original value untouched.
const createFormEncodedRedaction =
  (isSensitive: KeySensitivity) =>
  (value: string): string | undefined => {
    if (!value.includes('=')) {
      return undefined
    }
    const params = new URLSearchParams(value)
    // Snapshot the keys before mutating: URLSearchParams iterators are
    // live and `set()` collapses duplicate entries, so redacting a
    // multi-valued key mid-iteration could otherwise skip the entry
    // that shifts into the vacated slot. A multi-valued key appears
    // several times in the snapshot; the extra `set()` calls are no-ops.
    const keysToRedact = params
      .keys()
      .filter((key) => isSensitive(key))
      .toArray()
    for (const key of keysToRedact) {
      params.set(key, REDACTED)
    }
    return keysToRedact.length > 0 ? params.toString() : undefined
  }

const createValueRedaction = (
  isSensitive: KeySensitivity,
  redactFormEncoded: (value: string) => string | undefined,
): ((value: unknown) => unknown) => {
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const parsed = parseJsonText(value)
      return parsed === undefined
        ? (redactFormEncoded(value) ?? value)
        : JSON.stringify(redactValue(parsed))
    }
    if (typeof value !== 'object' || value === null) {
      return value
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactValue(item))
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, property]) => [
        key,
        isSensitive(key) ? REDACTED : redactValue(property),
      ]),
    )
  }
  return redactValue
}

const createUrlRedaction =
  (redactFormEncoded: (value: string) => string | undefined) =>
  (url: string): string => {
    const [path = '', ...querySegments] = url.split('?')
    if (querySegments.length === 0) {
      return url
    }
    const redacted = redactFormEncoded(querySegments.join('?'))
    return redacted === undefined ? url : `${path}?${redacted}`
  }

/**
 * Builds the {@link Redaction} engine for one protocol vocabulary. The
 * mechanism is owned here; the vocabulary is the caller's — the
 * consuming SDK passes every key that names a credential on ITS wire,
 * and the engine unions them with {@link BASE_SENSITIVE_KEYS}. A second,
 * separately declared tier names the user-entered fields the same wire
 * carries ({@link RedactionOptions.personalDataKeys}); both tiers blank
 * the same way, through every seat the engine reaches.
 * @param extraSensitiveKeys - Protocol-specific credential keys, in any
 * casing, added on top of the base vocabulary.
 * @param options - The personal-data tier; omit it to redact
 * credentials alone.
 * @param options.personalDataKeys - User-entered or identifying fields
 * the SDK names, in any casing.
 * @returns The bound redaction engine.
 */
export const createRedaction = (
  extraSensitiveKeys: Iterable<string> = [],
  { personalDataKeys = [] }: RedactionOptions = {},
): Redaction => {
  // Two tiers declared apart, ONE blanking verdict: every seat asks the
  // engine "must the value behind this key be blanked?", and the answer
  // is the same `******` whether the key opens an account or names its
  // owner. The request/response dumps print whole bodies on purpose (a
  // report needs them), so the only way a display name stays out of a
  // pasted report is for the key to be in this set — the SDK declares
  // it, since the core knows no wire's field names (api-core#50,
  // 2026-10-09). The credential tiers come first so the personal tier
  // can only ever ADD to what is blanked, never remove.
  const sensitiveKeys = new Set(
    [...BASE_SENSITIVE_KEYS, ...extraSensitiveKeys, ...personalDataKeys].map(
      (key) => key.toLowerCase(),
    ),
  )
  const isSensitive: KeySensitivity = (key) =>
    sensitiveKeys.has(key.toLowerCase())
  const redactFormEncoded = createFormEncodedRedaction(isSensitive)
  return {
    isSensitive,
    redactUrl: createUrlRedaction(redactFormEncoded),
    redactValue: createValueRedaction(isSensitive, redactFormEncoded),
  }
}

/**
 * The engine bound to {@link BASE_SENSITIVE_KEYS} alone — the default
 * every redaction seat falls back to when no vocabulary is injected.
 * A consumer SDK should build its own via {@link createRedaction} and
 * thread it through every seat; this default guarantees the generic
 * carriers are covered even where it forgets to.
 */
export const baseRedaction: Redaction = createRedaction()
