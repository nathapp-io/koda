export interface ExceptionResponse {
  prefix?: string;
  args?: Record<string, unknown>;
}

export function exceptionResponse(error: Error): ExceptionResponse {
  const getResponse = (error as Error & { getResponse?: () => unknown }).getResponse;
  if (typeof getResponse !== 'function') return {};

  const response: unknown = getResponse.call(error);
  if (typeof response !== 'object' || response === null) return {};
  return response as ExceptionResponse;
}
