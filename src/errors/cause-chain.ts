/**
 * The object links of a thrown value's `Error.cause` chain, the value
 * itself first — so a predicate that classifies by what an error wraps
 * (`new Error(msg, { cause })`) and a line that spells the whole chain
 * walk the same links. Cycle-guarded through a visited set; a primitive
 * link ends the walk, since nothing hangs off it.
 * @param error - What was thrown.
 * @yields Each object in the chain, outermost first.
 */
export const causeChain = function* (
  error: unknown,
): Generator<object, void, undefined> {
  const visited = new Set<object>()
  let current: unknown = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current)
    yield current
    current = 'cause' in current ? current.cause : undefined
  }
}
