/**
 * Structural host contract of the {@link syncDevices} decorator: the
 * optional sync notification the decorated method's host exposes —
 * `SessionAPI.notifySync` (routed through the lifecycle emitter) or a
 * facade's own, which enriches the payload before delegating.
 * @template TParams - The consumer-defined sync-params shape.
 * @internal
 */
interface HasNotifySync<TParams> {
  readonly notifySync?: ((params?: TParams) => Promise<void>) | undefined
}

/**
 * Method decorator factory that invokes the host's sync notification
 * **after** the decorated method resolves, forwarding `params` verbatim.
 * Generic over the consumer's sync-params shape (device ids, a type
 * filter…) like `SessionAPI` itself: `@syncDevices({ type })` forwards
 * a payload, `@syncDevices()` notifies without one. The host contract
 * is structural: the returned method's `this` names it, which types the
 * body and any `.call(host)` use, but a TC39 application site does not
 * check it — the method's own type carries no `this` — so it is
 * documented, not enforced, as it was in the SDKs' own copies. No
 * action is taken when the host exposes no hook.
 *
 * Intended for one-shot post-method notifications; this is **not** a
 * subscription. Exceptions thrown by the consumer's callback propagate
 * — the decorator does not swallow them, so a buggy sync handler
 * surfaces on the caller rather than dying silently.
 * @template TParams - The consumer-defined sync-params shape.
 * @param params - Payload forwarded to the host's `notifySync`.
 * @returns A method decorator that triggers the notification after
 * execution.
 * @category Decorators
 */
export const syncDevices =
  <TParams = never>(params?: TParams) =>
  <TArgs extends readonly unknown[], TResult>(
    target: (...args: TArgs) => Promise<TResult>,
    _context: ClassMethodDecoratorContext,
  ): ((this: HasNotifySync<TParams>, ...args: TArgs) => Promise<TResult>) =>
    async function newTarget(this: HasNotifySync<TParams>, ...args: TArgs) {
      const data = await target.call(this, ...args)
      await this.notifySync?.(params)
      return data
    }
