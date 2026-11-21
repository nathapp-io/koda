import { ApiError, extractErrorStatus } from '~/composables/useApi'

/** Whether an error represents a missing resource, from either the API envelope or HTTP status. */
export function isNotFoundError(err: unknown): boolean {
  return (err instanceof ApiError && (err.code === 404 || err.code === 40004))
    || extractErrorStatus(err) === 404
}
