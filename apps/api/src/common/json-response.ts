/**
 * Standard API response envelope: { data, meta?, message? }
 */
export class JsonResponse<T = unknown> {
  constructor(
    public readonly data: T,
    public readonly meta?: Record<string, unknown>,
    public readonly message?: string,
  ) {}

  static ok<T>(data: T): JsonResponse<T> {
    return new JsonResponse(data);
  }

  static created<T>(data: T): JsonResponse<T> {
    return new JsonResponse(data);
  }

  static paginated<T>(
    data: T[],
    meta: Record<string, unknown>,
  ): JsonResponse<T[]> {
    return new JsonResponse(data, meta);
  }
}
