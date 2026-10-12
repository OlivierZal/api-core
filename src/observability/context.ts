import { type Redaction, baseRedaction } from './redaction.ts'

/**
 * Minimal structural shape required by the API call loggers.
 *
 * Both `HttpRequestConfig` (used internally by `HttpClient.request`)
 * and any literal request config a consuming SDK builds satisfy this
 * contract structurally — no double type assertion is needed at the
 * call site, and the transport stays free to evolve.
 */
export interface LoggableRequestConfig {
  readonly data?: unknown
  readonly headers?: unknown
  readonly method?: string | undefined
  readonly params?: unknown
  readonly url?: string | undefined
}

// Fixed key order, so two records of one kind read alike.
const logKeys = [
  'dataType',
  'method',
  'url',
  'params',
  'headers',
  'requestData',
  'responseData',
  'status',
  'errorMessage',
]

// The two keys that carry a wire body; every other record field is a
// few hundred bytes at most.
const bodyKeys = new Set(['requestData', 'responseData'])

/**
 * The largest serialised body a log record carries. A body above it
 * is OMITTED whole — never cut — and the record names its size, so a
 * reader knows what was there and how big it was.
 *
 * Derivation, not taste: the host that reads these records back (a
 * Homey diagnostic report) keeps about the last hundred LINES of an
 * app's stdout (measured on a 46.7.5 report, 2026-10-12: exactly 100,
 * cut mid-object) and presumably as many of its stderr, and uploads
 * the report through a request-body limit — Athom's tracker holds a
 * report refused with 413 (homey-apps-sdk-issues#237), and a default
 * nginx caps a body at 1 MiB. Two streams of a hundred records of at
 * most 4 KiB each stay under that limit with room for the records'
 * own fields. A Classic `/User/ListDevices` or a Home `/context` body
 * runs past the bound on purpose: the SDK-authored lines name what
 * those bodies hold, and a report that reaches its reader beats one
 * that holds everything and never uploads. Measured in UTF-8 bytes of
 * the redacted JSON.
 */
export const MAX_LOGGED_BODY_BYTES = 4096

const encoder = new TextEncoder()

// An absent body serialises to nothing (`JSON.stringify(undefined)` is
// `undefined`, which the encoder reads as the empty string), so it is
// measured at zero and stays absent.
const boundBody = (body: unknown): unknown => {
  const bytes = encoder.encode(JSON.stringify(body)).length
  return bytes > MAX_LOGGED_BODY_BYTES
    ? `[body omitted: ${String(bytes)} bytes]`
    : body
}

/**
 * Abstract base for API call logging data, serializable to JSON with a
 * fixed set of log keys. Serialization redacts through the injected
 * {@link Redaction} — the same vocabulary the `HttpError` snapshot
 * uses, so a secret cannot reach a log through either route.
 */
export abstract class APICallLogData {
  declare public readonly dataType: string

  public readonly method?: string | undefined

  public readonly params: unknown

  public readonly url?: string | undefined

  readonly #redaction: Redaction

  protected constructor(
    config?: LoggableRequestConfig,
    redaction: Redaction = baseRedaction,
  ) {
    this.method = config?.method?.toUpperCase()
    this.url = config?.url
    this.params = config?.params
    this.#redaction = redaction
  }

  /**
   * Serializes the log data to JSON in the fixed key order, redacting
   * every value through the injected vocabulary. ONE record is ONE
   * line: the host that reads these lines back (a Homey diagnostic
   * report) keeps about the last hundred lines of an app's stdout, and
   * an indented Classic `/User/ListDevices` body alone ran past that
   * window, so a report carried the tail of one dump and no other line
   * at all. A body above {@link MAX_LOGGED_BODY_BYTES} is omitted whole
   * and counted, so a hundred records also fit the report's upload.
   * @returns The redacted, single-line JSON record.
   */
  public toString(): string {
    const filtered = Object.fromEntries(
      logKeys
        .filter((key) => Object.hasOwn(this, key))
        .map((key) => {
          const value = Object.getOwnPropertyDescriptor(this, key)
            ?.value as unknown
          // The URL rides the query-string vocabulary, not the deep
          // one: `redactValue` reads a one-pair query as a single
          // `path?key` = value entry whose key names no secret, so an
          // inline credential (`?token=…`) would pass in clear.
          if (key === 'url' && typeof value === 'string') {
            return [key, this.#redaction.redactUrl(value)]
          }
          const redacted = this.#redaction.redactValue(value)
          return [key, bodyKeys.has(key) ? boundBody(redacted) : redacted]
        }),
    )
    return JSON.stringify(filtered)
  }
}
