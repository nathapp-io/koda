type AppToast = typeof import('vue-sonner')['toast']

const noopToast = Object.assign((() => '') as unknown as AppToast, {
  success: () => '',
  error: () => '',
})

function isAppToast(value: unknown): value is AppToast {
  if (typeof value !== 'function') return false

  const maybeToast = value as {
    success?: unknown
    error?: unknown
  }

  return typeof maybeToast.success === 'function' && typeof maybeToast.error === 'function'
}

export function useAppToast(): AppToast {
  const nuxtApp = useNuxtApp() as Record<string, unknown>
  const maybeToast = nuxtApp.$toast

  if (isAppToast(maybeToast)) {
    return maybeToast
  }

  return noopToast
}
