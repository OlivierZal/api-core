import { APIError } from './base.ts'

/**
 * Thrown when a runtime validator rejects an upstream payload. The
 * consuming SDKs construct it at their zod boundaries (`parseOrThrow`,
 * which stays in each SDK); the class itself names no validator — the
 * validator's own error, typically a `ZodError`, rides the standard
 * `cause` chain as `unknown`. The `context` field surfaces which
 * boundary the payload came from (an endpoint or flow label such as
 * `'login'` or `'BFF /context'`) so consumer dashboards can group drift
 * alerts without parsing the message string.
 * @category Errors
 */
export class ValidationError extends APIError {
  public readonly context: string

  public override readonly name = 'ValidationError'

  /**
   * Builds the error from the validator's message, the boundary
   * `context` label, and (typically) the validator's error as the cause.
   * @param message - Human-readable error description.
   * @param options - Boundary label plus optional cause.
   * @param options.context - Boundary the rejected payload came from.
   * @param options.cause - Original error (typically a `ZodError`).
   */
  public constructor(
    message: string,
    options: { context: string; cause?: unknown },
  ) {
    const { context } = options
    super(message, options)
    this.context = context
  }
}
