export const useApi = () => {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl
  const auth = useAuth()

  const getHeaders = () => {
    const headers: Record<string, string> = {}
    if (auth.token && auth.token.value) {
      headers['Authorization'] = `Bearer ${auth.token.value}`
    }
    return headers
  }

  const get = (path: string, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, headers: getHeaders() })
  const post = (path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'POST', body, headers: getHeaders() })
  const patch = (path: string, body: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'PATCH', body, headers: getHeaders() })
  const delete_ = (path: string, options: Record<string, unknown> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'DELETE', headers: getHeaders() })

  return {
    $api: {
      get,
      post,
      patch,
      delete: delete_,
    },
  }
}
