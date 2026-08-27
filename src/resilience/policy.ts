/**
 * Unit of cross-cutting resilience logic around a request attempt.
 *
 * Each policy owns exactly one concern (rate-limiting, auth retry,
 * transient-error retry…) and wraps the caller's `attempt` with its
 * own semantics. Policies are **composed** via {@link CompositePolicy}
 * to build the request pipeline declaratively; a consumer with a
 * shorter chain may also nest `run` calls directly.
 *
 * Implementations MUST:
 * - run the caller's `attempt` at most once per `run` invocation per
 *   success path (retries are explicit loops the policy owns);
 * - propagate errors they don't own — a policy handles only the
 *   concern it was built for; anything else flows through untouched;
 * - be stateless across `run` calls (shared state — guards, gates —
 *   goes through constructor injection so it's visible + swappable).
 */
export interface ResiliencePolicy {
  /**
   * Runs the caller's attempt under this policy's semantics.
   */
  run: <T>(attempt: () => Promise<T>) => Promise<T>
}

/**
 * Compose N policies into a single pipeline. The first policy in the
 * array is the **outermost** wrapper — it sees the request before any
 * inner policy gets to decorate it, and sees the result last.
 *
 * Example: `new CompositePolicy([rate, auth, transient]).run(fetch)`
 * runs as `rate(auth(transient(fetch)))`. A transient 5xx is retried
 * first; a 401 on the last attempt triggers auth-retry; a 429 in any
 * branch hits the rate-limit gate outermost.
 *
 * An empty composite is a no-op pass-through.
 */
export class CompositePolicy implements ResiliencePolicy {
  // Innermost-first ordering, computed once — `run` only re-wraps the
  // attempt closure per call, never re-derives the pipeline.
  readonly #reversedPolicies: readonly ResiliencePolicy[]

  /**
   * Builds the pipeline from outermost to innermost policy.
   * @param policies - Policies in outer-to-inner order.
   */
  public constructor(policies: readonly ResiliencePolicy[]) {
    this.#reversedPolicies = policies.toReversed()
  }

  /**
   * Runs the attempt through the composed pipeline.
   * @param attempt - The request attempt to decorate.
   * @returns The attempt's resolved value.
   */
  public async run<T>(attempt: () => Promise<T>): Promise<T> {
    let wrapped: () => Promise<T> = attempt
    for (const policy of this.#reversedPolicies) {
      const inner = wrapped
      const wrap = async (): Promise<T> => policy.run(inner)
      wrapped = wrap
    }
    return wrapped()
  }
}
