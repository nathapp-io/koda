import { readFileSync } from 'fs'
import { resolve } from 'path'

const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj
  for (const key of keys) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

describe('EditAgentCapabilitiesDialog i18n', () => {
  const componentPath = resolve(__dirname, '../../components/EditAgentCapabilitiesDialog.vue')
  const componentSource = readFileSync(componentPath, 'utf-8')

  it('uses t("agents.form.editCapabilities") for DialogTitle', () => {
    expect(componentSource).toContain('t(\'agents.form.editCapabilities\')')
  })

  it('renders non-empty translated text for DialogTitle when zh locale is active', () => {
    const key = 'agents.form.editCapabilities'
    const translatedValue = getNestedValue(zh, key)

    expect(translatedValue).toBeDefined()
    expect(typeof translatedValue).toBe('string')
    expect((translatedValue as string).length).toBeGreaterThan(0)
    expect(translatedValue).not.toBe(key)
  })
})
