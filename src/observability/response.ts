import type { HttpResponse } from '../http/index.ts'
import type { Redaction } from './redaction.ts'
import { type LoggableRequestConfig, APICallLogData } from './context.ts'

/**
 * Structured log data for an API response.
 */
export class APICallResponseData extends APICallLogData {
  public override readonly dataType = 'API response'

  public readonly headers: unknown

  public readonly requestData: unknown

  public readonly responseData: unknown

  public readonly status?: number | undefined

  /**
   * Captures a response (and the request that produced it) into a
   * loggable snapshot.
   * @param response - Normalized response to snapshot.
   * @param requestConfig - Request configuration the response answered.
   * @param redaction - Redaction engine carrying the consumer's sensitive-key vocabulary; defaults to the base one.
   */
  public constructor(
    response?: HttpResponse,
    requestConfig?: LoggableRequestConfig,
    redaction?: Redaction,
  ) {
    super(requestConfig, redaction)
    this.headers = response?.headers
    this.status = response?.status
    this.requestData = requestConfig?.data
    this.responseData = response?.data
  }
}
