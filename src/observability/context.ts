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

// Fixed key order for consistent, readable JSON log output
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
   * Serializes the log data to indented JSON in the fixed key order,
   * redacting every value through the injected vocabulary.
   * @returns The redacted, pretty-printed JSON log line.
   */
  public toString(): string {
    const filtered = Object.fromEntries(
      logKeys
        .filter((key) => Object.hasOwn(this, key))
        .map((key) => [
          key,
          this.#redaction.redactValue(
            Object.getOwnPropertyDescriptor(this, key)?.value as unknown,
          ),
        ]),
    )
    return JSON.stringify(filtered, null, 2)
  }
}
