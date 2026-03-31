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

function toEnvelope<T>(response: unknown): ApiEnvelope<T> {
  if (isEnvelope<T>(response)) {
    return response;
  }

  const nested = (response as { data?: unknown })?.data;
  if (isEnvelope<T>(nested)) {
    return nested;
  }

  return { ret: -1, data: undefined as T };
}

export function unwrap<T>(response: unknown): T {
  const envelope = toEnvelope<T>(response);

  if (envelope.ret !== 0) {
    const err = new Error(`exception.${envelope.ret}`) as Error & {
      response?: { status: number; data: { message: string } };
    };
    err.response = {
      status: 400,
      data: { message: `exception.${envelope.ret}` },
    };
    throw err;
  }

  return envelope.data;
}
