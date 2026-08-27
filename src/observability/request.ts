import type { Redaction } from './redaction.ts'
import { type LoggableRequestConfig, APICallLogData } from './context.ts'

/**
 * Structured log data for an outgoing API request.
 */
export class APICallRequestData extends APICallLogData {
  public override readonly dataType = 'API request'

  public readonly headers: unknown

  public readonly requestData: unknown

  /**
   * Captures an outgoing request into a loggable snapshot.
   * @param config - Request configuration to snapshot.
   * @param redaction - Redaction engine carrying the consumer's sensitive-key vocabulary; defaults to the base one.
   */
  public constructor(config?: LoggableRequestConfig, redaction?: Redaction) {
    super(config, redaction)
    this.headers = config?.headers
    this.requestData = config?.data
  }
}
