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
  const globals = { clearError: jest.fn(), useI18n: () => ({ t: (key: string, params?: unknown) => params ? `${key} ${JSON.stringify(params)}` : key }) }
  const scope = globalThis as unknown as Record<string, unknown>
  let assign: ReturnType<typeof jest.fn>
  let reload: ReturnType<typeof jest.fn>
  let replaceState: ReturnType<typeof jest.fn>
  let previousWindow: unknown

  /** A stand-in for `window` showing `href` as the current document URL. */
  function standOn(href: string) {
    const url = new URL(href)
    scope.window = {
      location: { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash, assign, reload },
      history: { state: null, replaceState },
    }
  }

  async function click(selector: string, mounted: { one: (selector: string) => { props: Record<string, unknown> } | undefined }) {
    const handler = mounted.one(selector)?.props.onClick as (() => Promise<void>) | undefined
    await handler?.()
  }

  beforeEach(() => {
    assign = jest.fn()
    reload = jest.fn()
    replaceState = jest.fn()
    previousWindow = scope.window
    standOn('https://koda.test/login')
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
  it('AC-9 retry clears the error with the recorded redirect and starts a fresh document navigation', async () => {
    const clearError = jest.fn()
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/projects/acme' } } }, globals: { ...globals, clearError } })
    const button = mounted.one('[data-testid="error-page-retry"]')
    expect(button).toBeDefined()
    await click('[data-testid="error-page-retry"]', mounted)
    // A router replace to the current URL is dropped without re-running the guard, so the retry must reload.
    expect(assign).toHaveBeenCalledWith('/projects/acme')
    expect(reload).not.toHaveBeenCalled()
    expect(clearError).toHaveBeenCalledWith({ redirect: '/projects/acme' })
    mounted.unmount()
  })
  it('B4 retry reloads the document when the destination matches the current path and query', async () => {
    // `location.assign('/agents#staff')` while standing on `/agents` is a same-document fragment
    // navigation: the browser changes the URL without re-running the guard, so the outage page would
    // come back with no new `/api/auth/me` probe.
    standOn('https://koda.test/agents')
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/agents#staff' } } }, globals })
    await click('[data-testid="error-page-retry"]', mounted)
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://koda.test/agents#staff')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(assign).not.toHaveBeenCalled()
    mounted.unmount()
  })
  it('B4 retry keeps the destination fragment when only the fragment differs', async () => {
    standOn('https://koda.test/agents#sla')
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/agents#staff' } } }, globals })
    await click('[data-testid="error-page-retry"]', mounted)
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://koda.test/agents#staff')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(assign).not.toHaveBeenCalled()
    mounted.unmount()
  })
  it('B4 retry reloads in place for the exact current URL', async () => {
    standOn('https://koda.test/agents')
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/agents' } } }, globals })
    await click('[data-testid="error-page-retry"]', mounted)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(replaceState).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    mounted.unmount()
  })
  it('retry still reloads when clearing the error re-enters a failing client guard', async () => {
    standOn('https://koda.test/agents')
    const clearError = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Service Unavailable'))
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect: '/agents#staff' } } }, globals: { ...globals, clearError } })
    await click('[data-testid="error-page-retry"]', mounted)
    expect(clearError).toHaveBeenCalledWith({ redirect: '/agents#staff' })
    expect(reload).toHaveBeenCalledTimes(1)
    mounted.unmount()
  })
  it('post-review B4: retry never follows a redirect off this site', async () => {
    for (const redirect of ['//evil.test/x', 'https://evil.test/x', '/\\evil.test/x']) {
      const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 503, data: { redirect } } }, globals })
      await click('[data-testid="error-page-retry"]', mounted)
      mounted.unmount()
    }
    expect(assign.mock.calls.map(([target]) => target)).toEqual(['/', '/', '/'])
    expect(reload).not.toHaveBeenCalled()
  })
  it('AC-10 generic error renders translated title', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 500 } }, globals })
    expect(mounted.text()).toContain('errorPage.generic.title')
    mounted.unmount()
  })
  it('AC-1 404 renders the localized not-found title', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    const title = mounted.one('[data-testid="error-page-not-found-title"]')
    expect(title).toBeDefined()
    if (title) expect(mounted.textOf(title)).toBe('errorPage.notFound.title')
    mounted.unmount()
  })
  it('AC-2 404 renders the localized not-found body', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    const body = mounted.one('[data-testid="error-page-not-found-body"]')
    expect(body).toBeDefined()
    if (body) expect(mounted.textOf(body)).toBe('errorPage.notFound.body')
    mounted.unmount()
  })
  it('AC-3 404 home button clears the error and redirects home', () => {
    const clearError = jest.fn()
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals: { ...globals, clearError } })
    expect(mounted.one('[data-testid="error-page-not-found-title"]')).toBeDefined()
    ;(mounted.one('[data-testid="error-page-home"]')?.props.onClick as (() => void) | undefined)?.()
    expect(clearError).toHaveBeenCalledWith({ redirect: '/' })
    mounted.unmount()
  })
  it('AC-4 404 does not render Retry', () => {
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    expect(mounted.one('[data-testid="error-page-not-found-title"]')).toBeDefined()
    expect(mounted.one('[data-testid="error-page-retry"]')).toBeUndefined()
    mounted.unmount()
  })
  it('AC-5 not-found title is limited to 404 errors', () => {
    const notFound = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 404 } }, globals })
    const generic = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 500 } }, globals })
    expect(notFound.one('[data-testid="error-page-not-found-title"]')).toBeDefined()
    expect(generic.one('[data-testid="error-page-not-found-title"]')).toBeUndefined()
    notFound.unmount()
    generic.unmount()
  })
  it('post-review B5: the generic title renders through the real translator in both locales', () => {
    const rendered = (['en', 'zh'] as const).map((locale) => {
      const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 500 } }, globals: realI18n(locale) })
      const heading = mounted.one('h1')
      const title = heading ? mounted.textOf(heading) : mounted.text()
      mounted.unmount()
      return title
    })
    expect(rendered).toEqual(['Something went wrong (500)', '发生错误（500）'])
  })
  it('AC-11 home clears error and redirects home', () => {
    const clearError = jest.fn()
    const mounted = mountSfc(webFile('components', 'AppErrorPage.vue'), { props: { error: { statusCode: 500 } }, globals: { ...globals, clearError } })
    const button = mounted.one('[data-testid="error-page-home"]')
    expect(button).toBeDefined()
    ;(button?.props.onClick as (() => void) | undefined)?.()
    expect(clearError).toHaveBeenCalledWith({ redirect: '/' })
    mounted.unmount()
  })
})
