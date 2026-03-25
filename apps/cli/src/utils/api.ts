interface ApiErrorWithResponse extends Error {
  response?: {
    status: number;
    data: { message: string };
  };
}

interface ApiEnvelope<T> {
  ret: number;
  data: T;
}

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ret' in value &&
    typeof (value as { ret: unknown }).ret === 'number' &&
    'data' in value
  );
}

function toEnvelope<T>(response: ApiEnvelope<T> | { data: ApiEnvelope<T> }): ApiEnvelope<T> {
  if (isEnvelope<T>(response)) {
    return response;
  }

  if (isEnvelope<T>(response.data)) {
    return response.data;
  }

  return { ret: -1, data: undefined as T };
}

export function unwrap<T>(response: ApiEnvelope<T>): T;
export function unwrap<T>(response: { data: ApiEnvelope<T> }): T;
export function unwrap<T>(response: ApiEnvelope<T> | { data: ApiEnvelope<T> }): T {
  const envelope = toEnvelope(response);

  if (envelope.ret !== 0) {
    const err = new Error(`exception.${envelope.ret}`) as ApiErrorWithResponse;
    err.response = {
      status: 400, // Treat as validation/business error
      data: { message: `exception.${envelope.ret}` }
    };
    throw err;
  }

  return envelope.data;
}
