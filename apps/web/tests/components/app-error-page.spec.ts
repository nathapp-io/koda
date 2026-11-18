import { describe, expect, it, jest } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

describe('AppErrorPage', () => {
  const globals = { useI18n: () => ({ t: (key: string, params?: unknown) => params ? `${key} ${JSON.stringify(params)}` : key }) }

  it('AC-8 unavailable error renders translated title', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503 } }, globals })
    expect(mounted.text()).toContain('errorPage.unavailable.title')
    mounted.unmount()
  })
  it('AC-9 retry clears error and redirects to recorded route', () => {
    const clearError = jest.fn()
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/projects/acme' } } }, globals: { ...globals, clearError } })
    const button = mounted.one('[data-testid="error-page-retry"]')
    expect(button).toBeDefined()
    ;(button?.props.onClick as (() => void) | undefined)?.()
    expect(clearError).toHaveBeenCalledWith({ redirect: '/projects/acme' })
    mounted.unmount()
  })
  it('AC-10 generic error renders translated title', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    expect(mounted.text()).toContain('errorPage.generic.title')
    mounted.unmount()
  })
  it('AC-11 home clears error and redirects home', () => {
    const clearError = jest.fn()
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals: { ...globals, clearError } })
    const button = mounted.one('[data-testid="error-page-home"]')
    expect(button).toBeDefined()
    ;(button?.props.onClick as (() => void) | undefined)?.()
    expect(clearError).toHaveBeenCalledWith({ redirect: '/' })
    mounted.unmount()
  })
})
