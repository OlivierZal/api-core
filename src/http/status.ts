/**
 * HTTP status codes used across the SDK family. Single source so
 * callers don't redefine them per file (`HTTP_STATUS_UNAUTHORIZED` was
 * declared in three places before this module existed).
 *
 * Restricted to the codes the consuming SDKs actually branch on —
 * adding more here without a real call site is dead weight.
 */
export const HttpStatus = {
  /**
   * HTTP 502 — transient upstream failure. Eligible for retry on GET.
   */
  BadGateway: 502,
  /**
   * HTTP 400 — malformed request, but also how some upstreams report
   * an invalid or expired user token instead of 401. Consumers that
   * speak such a wire pass it to `AuthRetryPolicy` alongside
   * {@link HttpStatus.Unauthorized}.
   */
  BadRequest: 400,
  /**
   * HTTP 504 — transient upstream timeout. Eligible for retry on GET.
   */
  GatewayTimeout: 504,
  /**
   * HTTP 404 — the resource does not exist. Some upstreams use it as a
   * routine "nothing to describe" answer, not a failure.
   */
  NotFound: 404,
  /**
   * HTTP 503 — transient service unavailability. Eligible for retry on GET.
   */
  ServiceUnavailable: 503,
  /**
   * HTTP 429 — rate limited. Feeds into the rate-limit gate.
   */
  TooManyRequests: 429,
  /**
   * HTTP 401 — authentication required or rejected. Triggers session re-auth.
   */
  Unauthorized: 401,
} as const
