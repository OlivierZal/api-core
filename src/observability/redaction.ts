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
   * The FLAT reading: a header, a query pair or a form-encoded pair has
   * no enclosing key, so {@link RedactionOptions.notPersonalUnder}
   * never applies here.
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
   * counterpart of {@link Redaction.isSensitive}, and the one seat that
   * knows what encloses a key, so the one that honours
   * {@link RedactionOptions.notPersonalUnder}.
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
   * The seats where a personal-data key names something else. A key is
   * blanked wherever it rides, and one word can name a person's entry
   * in one object and the wire's own label in another: `name` is an
   * account holder and a building, and also the name of a device
   * setting. Declaring the word leaves one way to keep the label, and
   * this is it: each entry maps an ENCLOSING key to the personal-data
   * keys that keep their value in the objects directly under it, in any
   * casing. `{ settings: ['name'] }` keeps `name` in
   * `settings: [{ name, value }]` and blanks it everywhere else, the
   * root of a payload included. The enclosing key is the nearest one
   * (an array between the two is transparent), and it follows JSON
   * text riding under it.
   *
   * Only a declared personal-data key that names no credential can be
   * exempted: {@link createRedaction} throws on any other, so a
   * credential can never be printed through this option and an
   * exemption that would do nothing never passes for one that does.
   */
  readonly notPersonalUnder?:
    Readonly<Record<string, Iterable<string>>> | undefined
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

// Whether the value behind `key` must be blanked in an object sitting
// under `parent` — `undefined` at the root of a payload.
type SeatedKeySensitivity = (key: string, parent?: string) => boolean

const createValueRedaction = (
  isSensitiveUnder: SeatedKeySensitivity,
  redactFormEncoded: (value: string) => string | undefined,
): ((value: unknown) => unknown) => {
  // `parent` is the key the value rides under. An array hands it on to
  // its items and JSON text to what it parses to: both are the same
  // value in another dress, so the objects inside are still "under" it.
  const redactUnder = (value: unknown, parent?: string): unknown => {
    if (typeof value === 'string') {
      const parsed = parseJsonText(value)
      return parsed === undefined
        ? (redactFormEncoded(value) ?? value)
        : JSON.stringify(redactUnder(parsed, parent))
    }
    if (typeof value !== 'object' || value === null) {
      return value
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactUnder(item, parent))
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, property]) => [
        key,
        isSensitiveUnder(key, parent) ? REDACTED : redactUnder(property, key),
      ]),
    )
  }
  return (value) => redactUnder(value)
}

// The exemptions as the walk reads them: enclosing key to the keys kept
// under it, both lower-cased like the vocabulary. Built once, and the
// only place an exemption is judged: one that names a credential would
// print a secret, one that names a key outside the personal tier would
// do nothing while reading as if it did, so both throw here, where the
// suite of the SDK that wrote it sees them.
const createKeptKeys = (
  notPersonalUnder: Readonly<Record<string, Iterable<string>>>,
  isExemptible: KeySensitivity,
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(
    Object.entries(notPersonalUnder).map(([parent, keys]) => [
      parent.toLowerCase(),
      new Set(
        Iterator.from(keys).map((key) => {
          if (!isExemptible(key)) {
            throw new TypeError(
              `\`${key}\` cannot be exempted under \`${parent}\`: only a declared personal-data key that names no credential can`,
            )
          }
          return key.toLowerCase()
        }),
      ),
    ]),
  )

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
 * @param options.notPersonalUnder - The enclosing keys under which a
 * personal-data key names something else and keeps its value.
 * @param options.personalDataKeys - User-entered or identifying fields
 * the SDK names, in any casing.
 * @returns The bound redaction engine.
 * @throws {TypeError} When an exemption names a key that is not a
 * declared personal-data key, or one that also names a credential.
 */
export const createRedaction = (
  extraSensitiveKeys: Iterable<string> = [],
  { notPersonalUnder = {}, personalDataKeys = [] }: RedactionOptions = {},
): Redaction => {
  // Two tiers declared apart, ONE blanking verdict: every seat asks the
  // engine "must the value behind this key be blanked?", and the answer
  // is the same `******` whether the key opens an account or names its
  // owner. The request/response dumps print whole bodies on purpose (a
  // report needs them), so the only way a display name stays out of a
  // pasted report is for the key to be in this set — the SDK declares
  // it, since the core knows no wire's field names (api-core#50,
  // 2026-10-09). The three sources feed ONE set, a union, so the
  // personal tier can only ever ADD to what is blanked, never remove.
  const credentialKeys = new Set(
    [...BASE_SENSITIVE_KEYS, ...extraSensitiveKeys].map((key) =>
      key.toLowerCase(),
    ),
  )
  const personalKeys = new Set(
    Iterator.from(personalDataKeys).map((key) => key.toLowerCase()),
  )
  const sensitiveKeys = credentialKeys.union(personalKeys)
  const isSensitive: KeySensitivity = (key) =>
    sensitiveKeys.has(key.toLowerCase())
  // What the SDK may take back is narrower than what it added: a
  // personal key, in the seats it names, and never a credential — a key
  // both tiers hold stays blanked everywhere.
  const keptKeys = createKeptKeys(
    notPersonalUnder,
    (key) =>
      personalKeys.has(key.toLowerCase()) &&
      !credentialKeys.has(key.toLowerCase()),
  )
  const isSensitiveUnder: SeatedKeySensitivity = (key, parent) =>
    isSensitive(key) &&
    (parent === undefined ||
      keptKeys.get(parent.toLowerCase())?.has(key.toLowerCase()) !== true)
  const redactFormEncoded = createFormEncodedRedaction(isSensitive)
  return {
    isSensitive,
    redactUrl: createUrlRedaction(redactFormEncoded),
    redactValue: createValueRedaction(isSensitiveUnder, redactFormEncoded),
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
