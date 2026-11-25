import { getCurrentInstance } from 'vue'
import { clientIpHeaders } from '~/server/utils/client-ip'

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
  /**
   * The envelope `ret` — the API's own error code, not the HTTP status (a refused permission is
   * `40003`, which the filter answers with HTTP 403).
   */
  public readonly code: number
  /**
   * The HTTP status the API answered with, when the failure came off the wire. `code` alone cannot
   * answer "forbidden or missing" (a 403 is `ret: 40003`), so the status travels with the error.
   */
  public readonly status?: number
  public readonly errors?: Record<string, string[]>

  constructor(code: number, message: string, errors?: Record<string, string[]>, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.errors = errors
    this.status = status
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
 * The envelope `ret` codes that mean "you may not" and "it is not there".
 *
 * `@nathapp/nestjs-common` maps `FORBIDDEN` to `ret: 40003` with HTTP 403, and `NOT_FOUND` to
 * `ret: 404`; `40004` is the mirrored code the rest of this app already checks (`lib/not-found`,
 * the fleet pages). A caller that must treat both the same — so it never discloses whether a
 * forbidden row exists — has to look at these *and* the HTTP status, because an error that never
 * reached the envelope carries only the status.
 */
const UNAVAILABLE_CODES: readonly number[] = [403, 40003, 404, 40004]

/**
 * True when the failure says the resource is unavailable to this caller: refused (403 / `ret`
 * 40003) or missing (404 / `ret` 404 or 40004).
 *
 * Accepts every shape the app actually receives: a raw `$fetch`/Nuxt error (`status`,
 * `statusCode` or `response.status`), the normalized {@link ApiError} this adapter throws for an
 * enveloped answer (its `code` is the envelope `ret` and its `status` the HTTP status), and a
 * `status`-carrying plain error. Pure and exported for unit testing.
 */
export function isUnavailableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { code?: unknown; statusCode?: unknown; status?: unknown; response?: { status?: unknown } }
  const candidates = [e.status, e.statusCode, e.response?.status, e.code]
  return candidates.some(value => typeof value === 'number' && UNAVAILABLE_CODES.includes(value))
}

/** The first non-empty message a field-keyed error map carries for `field`. */
function fieldMessage(errors: unknown, field: string): string | undefined {
  if (errors === null || typeof errors !== 'object') return undefined
  const messages = (errors as Record<string, unknown>)[field]
  if (!Array.isArray(messages)) return undefined
  return messages.find((message): message is string => typeof message === 'string' && message.trim().length > 0)
}

/**
 * The validation message the API attached to one field, or undefined when the failure is not about it.
 *
 * A DTO that fails the global validation pipe answers `{ ret: -2, message, errors: { <field>: [message] } }`
 * (the `@nathapp/nestjs-common` default formatter), which `request()` turns into an `ApiError` carrying
 * `errors`; an error that never reached the envelope keeps the same body under `data`. A failure that is
 * not about a field at all — a refused reset token, for example — carries no `errors`, which is how a
 * caller tells "your input is wrong, try again" from "the thing you were given is dead".
 * Pure and exported for unit testing.
 */
export function extractFieldError(err: unknown, field: string): string | undefined {
  if (err === null || typeof err !== 'object') return undefined
  return fieldMessage((err as { errors?: unknown }).errors, field)
    ?? fieldMessage((err as { data?: { errors?: unknown } }).data?.errors, field)
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

/**
 * Fleet S1 slice 4c (D127): a download asks for a Blob, so ofetch hands the
 * error body over as a Blob too and request() cannot read `ret` from it.
 * Turn a JSON error Blob back into the ApiError every other call throws;
 * anything else is returned unchanged. Pure and exported for unit testing.
 */
export async function blobErrorToApiError(err: unknown): Promise<unknown> {
  if (err instanceof ApiError || err === null || typeof err !== 'object') return err
  const data = (err as { data?: unknown }).data
  if (!(data instanceof Blob)) return err
  try {
    const body = JSON.parse(await data.text()) as JsonResponse | null
    if (body && typeof body.ret === 'number') return new ApiError(body.ret, body.message || 'Request failed', body.errors, extractErrorStatus(err))
  }
  catch {
    // Not a JSON body: surface the original fetch error.
  }
  return err
}

/**
 * The locale the API should hear: it travels as `Accept-Language` on every request, when one can be
 * named (see the note on the unresolvable case below).
 *
 * `useI18n()` needs a component instance and throws
 * `SyntaxError: Must be called at the top of a setup function` without one — which is the situation
 * of any composable built in a route middleware, and `middleware/project.global.ts` builds this one.
 * Nuxt runs middleware inside the app context (`nuxtApp.runWithContext`), so the nuxt-i18n composer
 * on the Nuxt app answers the same question there and backs `useI18n()` up.
 *
 * The first navigation of a page load is earlier still: it runs inside the pages router plugin,
 * which Nuxt orders before the i18n plugin (`enforce: 'pre'`), so no composer exists yet and there
 * is no answer to give. That case returns undefined and the request names no locale, which leaves
 * the browser's own `Accept-Language` standing — request fetch forwards it on the server, and the
 * browser sends it itself on the client. Exported so a test can reach it without a mounted
 * component.
 */
export function resolveApiLocale(): { value: string } | undefined {
  // A component instance always wins: `useI18n()` is the reactive composer that follows the user's
  // language switch mid-session.
  if (getCurrentInstance() !== null) return useI18n().locale
  return nuxtAppLocale()
}

/** The locale the Nuxt app's i18n composer holds, once the i18n plugin has installed it. */
function nuxtAppLocale(): { value: string } | undefined {
  // `typeof` is the guard that keeps this safe where the auto-import is not injected (plain Node
  // tests): a bare reference would be a ReferenceError, a `typeof` check is not.
  if (typeof useNuxtApp !== 'function') return undefined
  const locale = (useNuxtApp() as { $i18n?: { locale?: { value?: unknown } } }).$i18n?.locale
  return typeof locale?.value === 'string' ? locale as { value: string } : undefined
}

export const useApi = () => {
  const config = useRuntimeConfig()
  // Server-side: ensure internal URL includes /api (E2E env provides host:port only)
  const internalBaseUrl = String(config.apiInternalUrl).replace(/\/+$/, '')
  const serverBaseUrl = internalBaseUrl.endsWith('/api')
    ? internalBaseUrl
    : `${internalBaseUrl}/api`
  const baseURL = import.meta.server ? serverBaseUrl : config.public.apiBaseUrl

  // Undefined before the i18n plugin has run (see resolveApiLocale): that request names no locale
  // instead of guessing one.
  const locale = resolveApiLocale()

  // SSR: this server calls the API itself, so name the browser it serves
  // (resolved by server/middleware/client-ip.ts; never a browser-sent header).
  const ssrEvent = import.meta.server ? useRequestEvent() : undefined
  const ssrClientIpHeaders = ssrEvent
    ? clientIpHeaders(ssrEvent.context.clientIp)
    : {}

  const getHeaders = (caller?: Record<string, string>) => ({
    ...mergeHeaders(caller, locale
      ? { 'Accept-Language': locale.value, lang: locale.value }
      : {}),
    ...ssrClientIpHeaders,
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
      // replayed exactly once. Only "did it work" matters here, so the boolean
      // wrapper is the right call — refreshSession() is what the live streams use
      // to tell a dead session from an outage (US-007).
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
          // The envelope carries the API's `ret`, never the HTTP status: keep the status alongside it,
          // so a caller can still tell a refused (403) answer from a missing (404) one.
          throw new ApiError(data.ret, data.message || 'Request failed', data.errors, extractErrorStatus(err))
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

  const put = <T = unknown>(path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, { ...options, method: 'PUT', body })

  const delete_ = <T = unknown>(path: string, options: Record<string, unknown> = {}) =>
    request<T>(`${baseURL}${path}`, { ...options, method: 'DELETE' })

  // D127: binary GET (job bundle). Same auth, locale and 401 retry as get().
  const download = async (path: string): Promise<Blob> => {
    let body: unknown
    try {
      body = await request<unknown>(`${baseURL}${path}`, { responseType: 'blob' })
    }
    catch (err: unknown) {
      throw await blobErrorToApiError(err)
    }
    if (!(body instanceof Blob)) throw new ApiError(-1, 'Expected a file download')
    return body
  }

  return {
    $api: {
      get,
      post,
      put,
      patch,
      delete: delete_,
      download,
    },
  }
}
