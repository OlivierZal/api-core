import type { Logger } from '../api/types.ts'
import { causeChain, isAPIError, RegistrySyncError } from '../errors/index.ts'
import { isHttpError } from '../http/index.ts'
import { isTransientNetworkFailure } from '../resilience/retry-backoff.ts'
import { failureReason } from './failure-streaks.ts'

const CAUSED_BY = ' — caused by '

// A caller's abort — a host shutting down, a flow cancelled — is a
// decision, never a condition to retry (the transient predicate leaves
// it out on purpose), but it is an expected one all the same.
const isAbort = (link: object): boolean =>
  link instanceof DOMException && link.name === 'AbortError'

// A link of the family says everything when its `cause` is, by
// contract, a payload: the refused `HttpError` under an
// `AuthenticationError`, the validator's error under a
// `ValidationError`. Two links say nothing on their own and leave the
// verdict to what they wrap: a `RegistrySyncError` carries whatever the
// enforced sync threw — a refusal, a transport failure, or a bug — and
// an `HttpError` with a `cause` is the dialect's failure reader having
// thrown, which the status line stands in for.
const isKnownLink = (link: object): boolean =>
  (isAPIError(link) && !(link instanceof RegistrySyncError)) ||
  (isHttpError(link) && link.cause === undefined) ||
  isAbort(link)

// Node's system errors and undici's carry their identity on `code`
// (`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`), which the message does
// not always repeat; a `DOMException`'s numeric legacy code names
// nothing a reader wants.
const codeSuffix = (link: object): string =>
  'code' in link && typeof link.code === 'string' ? ` (${link.code})` : ''

const describeLink = (link: object): string =>
  `${failureReason(link)}${codeSuffix(link)}`

// A validator's message is its issue list, pretty-printed over a dozen
// lines (zod's `ZodError`): every whitespace run — line breaks and the
// indentation around them — folds to one space, so the entry stays the
// one line a report counts.
const oneLine = (text: string): string => text.replaceAll(/\s+/gu, ' ')

/**
 * Whether a failure is one this package has a class for — an
 * `HttpError`, one of the {@link APIError} family, or a transport
 * failure (undici's `fetch failed`, the client's `TimeoutError`, a
 * caller's `AbortError`) — anywhere in its `cause` chain. Such a failure
 * is an expected condition of the wire, and its stack names only the
 * transport and this package; anything else is a programming error,
 * whose stack is the one thing that locates it. A wrapper is judged by
 * what it wraps: a {@link RegistrySyncError} carries whatever the
 * enforced sync threw, and an `HttpError` with a `cause` carries its
 * reader's own failure, so neither counts on its own.
 * @param error - What the call or cycle threw.
 * @returns `true` for a failure whose cause chain says everything.
 */
export const isKnownFailure = (error: unknown): boolean =>
  isTransientNetworkFailure(error) ||
  causeChain(error).some((link) => isKnownLink(link))

/**
 * A failure and its causes on one line, outermost first — `TypeError:
 * fetch failed — caused by ConnectTimeoutError: Connect Timeout Error
 * (UND_ERR_CONNECT_TIMEOUT)`: a host logger prints an error as its
 * message, and `fetch failed` on its own names nothing. Each link is its
 * {@link failureReason} plus its string `code` when it carries one; a
 * cycle is walked once; a thrown primitive is spelled by its value; a
 * message spanning lines is folded onto the one line.
 * @param error - What the call or cycle threw.
 * @returns The chain, joined by ` — caused by `.
 */
export const failureCauseChain = (error: unknown): string => {
  const links = causeChain(error)
    .map((link) => describeLink(link))
    .toArray()
  return oneLine(
    links.length === 0 ? failureReason(error) : links.join(CAUSED_BY),
  )
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
