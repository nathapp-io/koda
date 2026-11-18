import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createI18n } from 'vue-i18n'
import { mountSfc, webFile } from '../helpers/mount-sfc'

/** The real translated messages, so a locale the production translator refuses fails here too. */
const messages = Object.fromEntries(
  (['en', 'zh'] as const).map((locale) => [locale, JSON.parse(readFileSync(join(__dirname, '../../i18n/locales', `${locale}.json`), 'utf-8'))]),
)

/**
 * Review-1118 US-005 post-review B5: the component test used a translation stub, which cannot notice a message the
 * real translator refuses (`{{statusCode}}` throws `Not allowed nest placeholder` in Vue I18n). This is the installed
 * translator over the committed locale files.
 */
function realI18n(locale: 'en' | 'zh'): { useI18n: () => { t: (key: string, params?: Record<string, unknown>) => string } } {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages, missingWarn: false, fallbackWarn: false })
  return { useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params ?? {}) }) }
}

describe('AppErrorPage', () => {
  const globals = { useI18n: () => ({ t: (key: string, params?: unknown) => params ? `${key} ${JSON.stringify(params)}` : key }) }
  const scope = globalThis as unknown as Record<string, unknown>
  let assign: ReturnType<typeof jest.fn>
  let previousWindow: unknown

  beforeEach(() => {
    assign = jest.fn()
    previousWindow = scope.window
    scope.window = { location: { assign } }
  })

  afterEach(() => {
    if (previousWindow === undefined) delete scope.window
    else scope.window = previousWindow
  })

  it('AC-8 unavailable error renders translated title', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503 } }, globals })
    expect(mounted.text()).toContain('errorPage.unavailable.title')
    mounted.unmount()
  })
  it('AC-9 retry starts a fresh document navigation to the recorded route', () => {
    const clearError = jest.fn()
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/projects/acme' } } }, globals: { ...globals, clearError } })
    const button = mounted.one('[data-testid="error-page-retry"]')
    expect(button).toBeDefined()
    ;(button?.props.onClick as (() => void) | undefined)?.()
    // A router replace to the current URL is dropped without re-running the guard, so the retry must reload.
    expect(assign).toHaveBeenCalledWith('/projects/acme')
    expect(clearError).not.toHaveBeenCalled()
    mounted.unmount()
  })
  it('post-review B4: retry never follows a redirect off this site', () => {
    for (const redirect of ['//evil.test/x', 'https://evil.test/x', '/\\evil.test/x']) {
      const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect } } }, globals })
      ;(mounted.one('[data-testid="error-page-retry"]')?.props.onClick as (() => void) | undefined)?.()
      mounted.unmount()
    }
    expect(assign.mock.calls.map(([target]) => target)).toEqual(['/', '/', '/'])
  })
  it('AC-10 generic error renders translated title', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    expect(mounted.text()).toContain('errorPage.generic.title')
    mounted.unmount()
  })
  it('post-review B5: the generic title renders through the real translator in both locales', () => {
    const rendered = (['en', 'zh'] as const).map((locale) => {
      const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals: realI18n(locale) })
      const heading = mounted.one('h1')
      const title = heading ? mounted.textOf(heading) : mounted.text()
      mounted.unmount()
      return title
    })
    expect(rendered).toEqual(['Something went wrong (404)', '发生错误（404）'])
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
