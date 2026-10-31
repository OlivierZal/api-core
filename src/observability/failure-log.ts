import type { Logger } from '../api/types.ts'
import { causeChain, isAPIError } from '../errors/index.ts'
import { isHttpError } from '../http/index.ts'
import { isTransientNetworkFailure } from '../resilience/retry-backoff.ts'
import { failureReason } from './failure-streaks.ts'

const CAUSED_BY = ' — caused by '

// A caller's abort — a host shutting down, a flow cancelled — is a
// decision, never a condition to retry (the transient predicate leaves
// it out on purpose), but it is an expected one all the same.
const isAbort = (link: object): boolean =>
  link instanceof DOMException && link.name === 'AbortError'

// Node's system errors and undici's carry their identity on `code`
// (`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`), which the message does
// not always repeat; a `DOMException`'s numeric legacy code names
// nothing a reader wants.
const codeSuffix = (link: object): string =>
  'code' in link && typeof link.code === 'string' ? ` (${link.code})` : ''

const describeLink = (link: object): string =>
  `${failureReason(link)}${codeSuffix(link)}`

/**
 * Whether a failure is one this package has a class for — an
 * `HttpError`, one of the {@link APIError} family, or a transport
 * failure (undici's `fetch failed`, the client's `TimeoutError`, a
 * caller's `AbortError`) — anywhere in its `cause` chain. Such a failure
 * is an expected condition of the wire, and its stack names only the
 * transport and this package; anything else is a programming error,
 * whose stack is the one thing that locates it.
 * @param error - What the call or cycle threw.
 * @returns `true` for a failure whose cause chain says everything.
 */
export const isKnownFailure = (error: unknown): boolean =>
  isTransientNetworkFailure(error) ||
  causeChain(error).some(
    (link) => isAPIError(link) || isHttpError(link) || isAbort(link),
  )

/**
 * A failure and its causes on one line, outermost first — `TypeError:
 * fetch failed — caused by ConnectTimeoutError: Connect Timeout Error
 * (UND_ERR_CONNECT_TIMEOUT)`: a host logger prints an error as its
 * message, and `fetch failed` on its own names nothing. Each link is its
 * {@link failureReason} plus its string `code` when it carries one; a
 * cycle is walked once; a thrown primitive is spelled by its value.
 * @param error - What the call or cycle threw.
 * @returns The chain, joined by ` — caused by `.
 */
export const failureCauseChain = (error: unknown): string => {
  const links = causeChain(error)
    .map((link) => describeLink(link))
    .toArray()
  return links.length === 0 ? failureReason(error) : links.join(CAUSED_BY)
}

/**
 * Write a failure to the log the way a diagnostic report can read it: a
 * {@link isKnownFailure | known failure} as ONE line — the label, then
 * its {@link failureCauseChain} — with no stack, since a transient's ten
 * transport frames read as a crash in a report; anything else as the
 * label followed by the error object, so a programming error keeps the
 * stack that locates it.
 * @param logger - The sink.
 * @param label - What failed, ending in a colon (`Failed to fetch
 * devices:`).
 * @param error - What it threw.
 */
export const logFailure = (
  logger: Logger,
  label: string,
  error: unknown,
): void => {
  if (isKnownFailure(error)) {
    logger.error(`${label} ${failureCauseChain(error)}`)
    return
  }
  logger.error(label, error)
}
