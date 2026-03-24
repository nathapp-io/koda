interface ApiErrorWithResponse extends Error {
  response?: {
    status: number;
    data: { message: string };
  };
}

export function unwrap<T>(response: { ret: number; data: T }): T {
  if (response.ret !== 0) {
    const err = new Error(`exception.${response.ret}`) as ApiErrorWithResponse;
    err.response = {
      status: 400, // Treat as validation/business error
      data: { message: `exception.${response.ret}` }
    };
    throw err;
  }
  return response.data;
}
