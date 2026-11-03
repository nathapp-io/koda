/** Returns a same-origin local path suitable for a post-authentication redirect. */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/'
  if (value[1] === '/' || value[1] === '\\' || [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })) return '/'

  const path = value.split(/[?#]/, 1)[0]
  if (path === '/login' || path === '/register') return '/'
  return value
}
