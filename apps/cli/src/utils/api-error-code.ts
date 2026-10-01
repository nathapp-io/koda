/**
 * The generated client throws the parsed error body `{ ret, message }` for an HTTP failure; `ret` is the
 * API's AppException code (409 for a conflict). Read it as a structured code; never match the message.
 */
export function apiErrorCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('ret' in err)) return undefined;
  const ret = (err as { ret: unknown }).ret;
  return typeof ret === 'number' ? ret : undefined;
}
