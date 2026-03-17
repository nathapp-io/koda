// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useApi = () => {
  const config = useRuntimeConfig()
  const baseURL = config.public.apiBaseUrl

  const get = (path: string, options: Record<string, any> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options })
  const post = (path: string, body: Record<string, any> = {}, options: Record<string, any> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'POST', body })
  const patch = (path: string, body: Record<string, any> = {}, options: Record<string, any> = {}) =>
    $fetch(`${baseURL}${path}`, { ...options, method: 'PATCH', body })
  const delete_ = (path: string, options: Record<string, any> = {}) =>
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
