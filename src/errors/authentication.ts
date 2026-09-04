import { APIError } from './base.ts'

/**
 * The server rejected the credentials, the login response could not be
 * parsed, or the reactive re-authentication that followed an
 * auth-failure status failed in turn.
 *
 * Which status a protocol answers on its login path is the consuming
 * SDK's vocabulary, not this class's: MELCloud replies 401, Gizwits
 * replies 400 or 401, and `AuthRetryPolicy` takes that set as a
 * parameter.
 *
 * `name` is typed as `string` rather than as its own literal so a
 * subclass — `AuthenticationThrottledError` — can narrow it. A code-font
 * name, not a `link`: a consumer that re-exports this class without the
 * subclass (heatzy does) cannot resolve the link in its own `.d.ts`.
 * @category Errors
 */
export class AuthenticationError extends APIError {
  public override readonly name: string = 'AuthenticationError'
}
