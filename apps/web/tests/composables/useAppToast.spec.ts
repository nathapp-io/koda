import { describe, test, expect, afterEach } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const composablePath = join(webDir, 'composables', 'useAppToast.ts')
const originalUseNuxtApp = (globalThis as Record<string, unknown>).useNuxtApp

afterEach(() => {
  (globalThis as Record<string, unknown>).useNuxtApp = originalUseNuxtApp
})

describe('useAppToast composable', () => {
  test('source contains runtime validation for toast injection', () => {
    const source = readFileSync(composablePath, 'utf-8')
    expect(source).toContain('isAppToast')
    expect(source).toContain('return noopToast')
  })

  test('returns injected toast when available', async () => {
    const fakeToast = Object.assign(
      (_message: string) => 'id-1',
      {
        success: (_message: string) => 'id-2',
        error: (_message: string) => 'id-3',
      },
    )

    ;(globalThis as Record<string, unknown>).useNuxtApp = () => ({ $toast: fakeToast })

    const mod = await import(`${composablePath}`)
    const toast = mod.useAppToast()

    expect(toast).toBe(fakeToast)
    expect(toast.success('ok')).toBe('id-2')
    expect(toast.error('bad')).toBe('id-3')
  })

  test('falls back to noop toast when injection is missing', async () => {
    (globalThis as Record<string, unknown>).useNuxtApp = () => ({})

    const mod = await import(`${composablePath}`)
    const fallbackToast = mod.useAppToast()

    expect(typeof fallbackToast).toBe('function')
    expect(typeof fallbackToast.success).toBe('function')
    expect(typeof fallbackToast.error).toBe('function')
  })
})
