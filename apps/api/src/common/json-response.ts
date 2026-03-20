/**
 * Stub — implementation will be filled in by US-004 implementer.
 * Provides the standard API response envelope: { data, meta?, message? }
 */
export class JsonResponse<T = unknown> {
  constructor(
    public readonly data: T,
    public readonly meta?: Record<string, unknown>,
    public readonly message?: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static ok<T>(_data: T): JsonResponse<T> {
    throw new Error('JsonResponse.ok is not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static created<T>(_data: T): JsonResponse<T> {
    throw new Error('JsonResponse.created is not implemented');
  }

  static paginated<T>(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _data: T[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _meta: Record<string, unknown>,
  ): JsonResponse<T[]> {
    throw new Error('JsonResponse.paginated is not implemented');
  }
}
