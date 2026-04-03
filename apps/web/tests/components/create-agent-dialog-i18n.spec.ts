import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'CreateAgentDialog.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('US-001-B AC6: CreateAgentDialog key-reveal warning paragraph uses t("agents.rotateKey.apiKeyReveal.message")', () => {
  test('source uses t("agents.rotateKey.apiKeyReveal.message") for key-reveal warning paragraph', () => {
    const source = getSource()
    expect(source).toContain("t('agents.rotateKey.apiKeyReveal.message')")
  })

  test('source does not contain hardcoded "Copy this API key now. It will not be shown again." string', () => {
    const source = getSource()
    const hasHardcodedMessage = source.includes('Copy this API key now. It will not be shown again.')
    expect(hasHardcodedMessage).toBe(false)
  })
})

describe('US-001-B AC7: CreateAgentDialog key-reveal copy button idle label uses t("agents.rotateKey.apiKeyReveal.copy")', () => {
  test('source uses t("agents.rotateKey.apiKeyReveal.copy") for copy button when idle', () => {
    const source = getSource()
    expect(source).toContain("t('agents.rotateKey.apiKeyReveal.copy')")
  })

  test('source does not contain hardcoded "Copy" string for copy button initial state', () => {
    const source = getSource()
    const copyButtonInitialState = source.includes("ref('Copy')") || source.includes("ref(\"Copy\")")
    expect(copyButtonInitialState).toBe(false)
  })
})

describe('US-001-B AC8: CreateAgentDialog key-reveal copy button activated label uses t("agents.rotateKey.apiKeyReveal.copied")', () => {
  test('source uses t("agents.rotateKey.apiKeyReveal.copied") for copy button when activated', () => {
    const source = getSource()
    expect(source).toContain("t('agents.rotateKey.apiKeyReveal.copied')")
  })

  test('source does not contain hardcoded "Copied!" string for copy button activated state', () => {
    const source = getSource()
    const hasHardcodedCopied = source.includes("'Copied!'") || source.includes('"Copied!"')
    expect(hasHardcodedCopied).toBe(false)
  })
})

describe('US-001-B AC9: CreateAgentDialog key-reveal done button uses t("common.done")', () => {
  test('source uses t("common.done") for done button', () => {
    const source = getSource()
    expect(source).toContain("t('common.done')")
  })

  test('source does not contain hardcoded "Done" string in done button', () => {
    const source = getSource()
    const doneButtonMatch = source.match(/<Button[^>]*@click=["']handleDone["'][^>]*>.*?Done.*?<\/Button>/s)
    if (doneButtonMatch) {
      const hasHardcodedDone = /Done(?!\w)/.test(doneButtonMatch[0])
      expect(hasHardcodedDone).toBe(false)
    }
  })
})
