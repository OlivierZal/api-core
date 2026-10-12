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
   * report) keeps about the last hundred lines of an app's stdout and
   * of its stderr, and an indented Classic `/User/ListDevices` body
   * alone ran past that window, so a report carried the tail of one
   * dump and no other line at all. Compact JSON keeps every byte of
   * the dump — no truncation, no demotion — and costs two lines per
   * call instead of the whole window.
   * @returns The redacted, single-line JSON record.
   */
  public toString(): string {
    const filtered = Object.fromEntries(
      logKeys
        .filter((key) => Object.hasOwn(this, key))
        .map((key) => {
          const value = Object.getOwnPropertyDescriptor(this, key)
            ?.value as unknown
          return [
            key,
            // The URL rides the query-string vocabulary, not the deep
            // one: `redactValue` reads a one-pair query as a single
            // `path?key` = value entry whose key names no secret, so an
            // inline credential (`?token=…`) would pass in clear.
            key === 'url' && typeof value === 'string'
              ? this.#redaction.redactUrl(value)
              : this.#redaction.redactValue(value),
          ]
        }),
    )
    return JSON.stringify(filtered)
  }
}
