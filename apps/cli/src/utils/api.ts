export function unwrap<T>(response: { data: { ret: number; data: T } }): T {
  if (response.data.ret !== 0) {
    throw new Error(`[unwrap] API returned ret=${response.data.ret}`);
  }
  return response.data.data;
}
