/**
 * API response shape from @nathapp/nestjs-common JsonResponse.
 *
 * Success: { ret: 0, data: T }
 * Error:   { ret: <non-zero>, message: string, errors?: Record<string, string[]> }
 */
interface JsonResponse<T = unknown> {
  ret: number
  data?: T
  message?: string
  errors?: Record<string, string[]>
}

/**
 * Custom error thrown when the API returns a non-zero `ret` code
 * or when $fetch throws on non-2xx HTTP status.
 */
export class ApiError extends Error {
  public readonly code: number
  public readonly errors?: Record<string, string[]>

  constructor(code: number, message: string, errors?: Record<string, string[]>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.errors = errors
  }

  /** First field-level validation error, or the top-level message */
  get firstError(): string {
    if (this.errors) {
      const firstField = Object.values(this.errors)[0]
      if (firstField?.[0]) return firstField[0]
    }
    return this.message
  }
}

/**
 * Unwrap a JsonResponse envelope.
 * - ret === 0  → return data
 * - ret !== 0  → throw ApiError
 * - No envelope (e.g. health check) → pass through
 */
function unwrap<T>(response: unknown): T {
  if (
    response !== null &&
    typeof response === 'object' &&
    'ret' in response
  ) {
    const json = response as JsonResponse<T>
    if (json.ret !== 0) {
      throw new ApiError(json.ret, json.message || 'Unknown error', json.errors)
    }
    return json.data as T
  }
  // Not a JsonResponse envelope — return as-is
  return response as T
}

/**
 * Extract a human-readable error message from a caught error.
 * Handles: ApiError, $fetch FetchError (with .data body), generic Error.
 *
 * Note: ofetch defines `data` as a getter via Object.defineProperty, so we
 * must access it directly rather than relying solely on `'data' in err`.
 */
export function extractApiError(err: unknown): string {
  // ApiError from our unwrap
  if (err instanceof ApiError) {
    return err.firstError
  }
  // $fetch FetchError — the JSON error body is in err.data (getter from response._data)
  if (err !== null && typeof err === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (err as any).data as JsonResponse | undefined
    if (data?.message) return data.message
    if (data?.errors) {
      const firstField = Object.values(data.errors)[0]
      if (firstField?.[0]) return firstField[0]
    }
    // Also check statusMessage from ofetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusMessage = (err as any).statusMessage as string | undefined
    if (statusMessage) return statusMessage
  }
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

export const useApi = () => {
  const config = useRuntimeConfig()
  // Server-side: ensure internal URL includes /api (E2E env provides host:port only)
  const internalBaseUrl = String(config.apiInternalUrl).replace(/\/+$/, '')
  const serverBaseUrl = internalBaseUrl.endsWith('/api')
    ? internalBaseUrl
    : `${internalBaseUrl}/api`
  const baseURL = import.meta.server ? serverBaseUrl : config.public.apiBaseUrl

  const getHeaders = () => {
    const headers: Record<string, string> = {
      'Accept-Language': locale.value,
      'lang': locale.value, 
    }
    if (auth.token && auth.token.value) {
      headers['Authorization'] = `Bearer ${auth.token.value}`
    }
    return headers
  }

  const request = async <T = unknown>(
    url: string,
    options: Record<string, unknown> = {},
  ): Promise<T> => {
    try {
      const response = await $fetch(url, { ...options, headers: getHeaders() })
      return unwrap<T>(response)
    } catch (err: unknown) {
      // Re-throw ApiError as-is (from unwrap)
      if (err instanceof ApiError) throw err
      // $fetch FetchError on non-2xx — try to extract JsonResponse body
      if (
        err !== null &&
        typeof err === 'object' &&
        'data' in err
      ) {
        const data = (err as { data?: JsonResponse }).data
        if (data && typeof data.ret === 'number') {
          throw new ApiError(data.ret, data.message || 'Request failed', data.errors)
        }
      }
      throw err
    }
  }

  const get = <T = unknown>(path: string, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, options)

  const post = <T = unknown>(path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, { ...options, method: 'POST', body })

  const patch = <T = unknown>(path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, { ...options, method: 'PATCH', body })

  const delete_ = <T = unknown>(path: string, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, { ...options, method: 'DELETE' })

  return {
    $api: {
      get,
      post,
      patch,
      delete: delete_,
    },
  }
}
