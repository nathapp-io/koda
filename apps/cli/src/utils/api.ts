export function unwrap<T>(response: { data: { ret: number; data: T } }): T {
  if (response.data.ret !== 0) {
    const err = new Error(`exception.${response.data.ret}`);
    (err as any).response = {
      status: 400, // Treat as validation/business error
      data: { message: `exception.${response.data.ret}` }
    };
    throw err;
  }
  return response.data.data;
}
