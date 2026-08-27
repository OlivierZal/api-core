import { isHttpError } from '../http/index.ts'
import type { APICallLogData } from './context.ts'
import type { Redaction } from './redaction.ts'
import { APICallRequestData } from './request.ts'
import { APICallResponseData } from './response.ts'

/**
 * Log data extended with the error message from a failed API call.
 */
export interface APICallLogDataWithErrorMessage extends APICallLogData {
  readonly errorMessage: string
}

const withErrorMessage = (
  data: APICallLogData,
  message: string,
): APICallLogDataWithErrorMessage =>
  Object.assign(data, { errorMessage: message })

/**
 * Create structured error log data from a failed HTTP request.
 * Uses response data when the error carries one, otherwise falls back to
 * request-only data.
 * @param error - The error thrown by the HTTP client.
 * @param redaction - Redaction engine applied when the data serializes.
 * @returns Structured log data including the error message.
 */
export const createAPICallErrorData = (
  error: Error,
  redaction?: Redaction,
): APICallLogDataWithErrorMessage => {
  if (isHttpError(error)) {
    return withErrorMessage(
      new APICallResponseData(error.response, error.config, redaction),
      error.message,
    )
  }
  return withErrorMessage(
    new APICallRequestData(undefined, redaction),
    error.message,
  )
}
