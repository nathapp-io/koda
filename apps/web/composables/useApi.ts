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

  /** First non-empty field-level validation error, or the top-level message */
  get firstError(): string {
    if (this.errors) {
      for (const messages of Object.values(this.errors)) {
        const first = messages.find((msg) => msg && msg.trim().length > 0)
        if (first) return first
      }
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

/**
 * Merge caller-supplied headers over the composable's locale base headers.
 * Caller headers win on key conflicts. Pure and exported for unit testing
 * (H9: caller headers must be merged, not silently replaced).
 */
export function mergeHeaders(
  caller: Record<string, string> = {},
  base: Record<string, string>,
): Record<string, string> {
  return { ...base, ...caller }
}

/**
 * Extract the HTTP status from a caught error (M22).
 * $fetch FetchError exposes `status`; some wrapped errors only carry
 * `response.status`. Non-numeric or missing statuses yield undefined.
 * Pure and exported for unit testing.
 */
export function extractErrorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const e = err as { status?: unknown; response?: { status?: unknown } }
  if (typeof e.status === 'number') return e.status
  if (typeof e.response?.status === 'number') return e.response.status
  return undefined
}

/**
 * Decide whether a failed request should be silently refreshed and retried
 * (M22): only on 401, only on the client (SSR must surface errors directly),
 * and never twice — the caller passes its `__retried` flag as the loop guard.
 * Pure and exported for unit testing.
 */
export function shouldRetryAfter401(
  status: number | undefined,
  isClient: boolean,
  alreadyRetried: boolean,
): boolean {
  return status === 401 && isClient && !alreadyRetried
}

export const useApi = () => {
  const config = useRuntimeConfig()
  // Server-side: ensure internal URL includes /api (E2E env provides host:port only)
  const internalBaseUrl = String(config.apiInternalUrl).replace(/\/+$/, '')
  const serverBaseUrl = internalBaseUrl.endsWith('/api')
    ? internalBaseUrl
    : `${internalBaseUrl}/api`
  const baseURL = import.meta.server ? serverBaseUrl : config.public.apiBaseUrl

  const { locale } = useI18n()

  const getHeaders = (caller?: Record<string, string>) =>
    mergeHeaders(caller, {
      'Accept-Language': locale.value,
      'lang': locale.value,
    })

  // H9: on the server, route every call through useRequestFetch() so the
  // incoming request's cookie header is forwarded to the upstream API.
  // Without this, deep-linked SSR pages lose the browser session and the
  // auth middleware bounces the user to /login. On the client this is just
  // $fetch (the browser attaches cookies itself).
  // Minimal callable signature: keeping the raw union of useRequestFetch()'s
  // return type sends TS overload resolution into "excessive stack depth" on
  // generic calls. Branches are cast separately for the same reason — a single
  // ternary would form the deep union type before the cast applies.
  type ApiFetchFn = <T = unknown>(url: string, options?: Record<string, unknown>) => Promise<T>
  let requestFetch: ApiFetchFn
  if (import.meta.server) {
    requestFetch = useRequestFetch() as unknown as ApiFetchFn
  } else {
    requestFetch = $fetch as unknown as ApiFetchFn
  }

  const request = async <T = unknown>(
    url: string,
    options: Record<string, unknown> = {},
  ): Promise<T> => {
    // __retried is the M22 loop guard — destructured out so it never
    // reaches the wire as a fetch option. Declared before the try so the
    // catch block can read it.
    const { headers: callerHeaders, __retried: alreadyRetried, ...rest } = options
    try {
      const response = await requestFetch(url, {
        ...rest,
        headers: getHeaders(callerHeaders as Record<string, string> | undefined),
      })
      return unwrap<T>(response)
    } catch (err: unknown) {
      // M22: one silent refresh + retry on 401 before surfacing the error.
      // The 15-minute access token expires mid-session; refresh() renews the
      // httpOnly cookies via the server proxy and the original request is
      // replayed exactly once (useAuth clears the stale user when refresh
      // fails, so repeated 401s fall through to the auth middleware).
      if (
        shouldRetryAfter401(
          extractErrorStatus(err),
          import.meta.client === true,
          alreadyRetried === true,
        )
      ) {
        const { refresh } = useAuth()
        if (await refresh()) {
          return request<T>(url, { ...options, __retried: true })
        }
      }
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
