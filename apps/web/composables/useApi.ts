export const useApi = () => {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl

  const get = (path: string, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options })
  const post = (path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'POST', body })
  const patch = (path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'PATCH', body })
  const delete_ = (path: string, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'DELETE' })

  return {
    $api: {
      get,
      post,
      patch,
      delete: delete_,
    },
  }
}
