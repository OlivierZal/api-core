/**
 * `"3 failed attempts"`, `"1 minute"`: a count and its noun, the noun
 * pluralised with a bare `s` — every noun the log lines count takes one.
 * One helper for the package: the rate-limit gate and the session's
 * streak lines used to carry a twin each.
 * @param count - The number to print.
 * @param noun - The singular noun.
 * @returns The count followed by the noun, pluralised past one.
 */
export const pluralize = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`
