import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'RotateKeyDialog.vue')
const enJsonPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhJsonPath = join(webDir, 'i18n', 'locales', 'zh.json')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

function getEnJson(): string {
  return readFileSync(enJsonPath, 'utf-8')
}

function getZhJson(): string {
  return readFileSync(zhJsonPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — DialogTitle uses t('agents.rotateKey.title')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC1: When RotateKeyDialog renders with a closed state, DialogTitle text is sourced from t('agents.rotateKey.title')", () => {
  test('source does NOT contain hardcoded string "Rotate API Key" in DialogTitle', () => {
    const source = getSource()
    const hasHardcodedTitle = source.match(/<DialogTitle>\s*Rotate API Key\s*<\/DialogTitle>/)
    expect(hasHardcodedTitle).toBeNull()
  })

  test('source uses t("agents.rotateKey.title") or t("agents.rotateKey.title ") in DialogTitle', () => {
    const source = getSource()
    const usesI18nTitle = source.match(/<DialogTitle>\s*\{\{\s*t\s*\(\s*['"]agents\.rotateKey\.title['"]\s*\)\s*\}\}\s*<\/DialogTitle>/)
    expect(usesI18nTitle).not.toBeNull()
  })

  test('en.json contains agents.rotateKey.title key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.agents?.rotateKey?.title).toBeDefined()
  })

  test('zh.json contains agents.rotateKey.title key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.agents?.rotateKey?.title).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — confirm body uses t('agents.rotateKey.confirmBody') with agent name interpolated
// ──────────────────────────────────────────────────────────────────────────────

describe("AC2: When RotateKeyDialog renders the confirmation form, paragraph body text is sourced from t('agents.rotateKey.confirmBody') with agent name interpolated", () => {
  test('source does NOT contain hardcoded string "Are you sure you want to rotate the API key for"', () => {
    const source = getSource()
    const hasHardcodedBody = source.includes("Are you sure you want to rotate the API key for")
    expect(hasHardcodedBody).toBe(false)
  })

  test('source uses t("agents.rotateKey.confirmBody") with agent.name interpolation', () => {
    const source = getSource()
    const usesI18nConfirmBody =
      source.match(/t\s*\(\s*['"]agents\.rotateKey\.confirmBody['"]\s*,/) ||
      source.match(/t\s*\(\s*['"]agents\.rotateKey\.confirmBody['"]\s*\)/)
    expect(usesI18nConfirmBody).not.toBeNull()
  })

  test('en.json contains agents.rotateKey.confirmBody key with {name} interpolation', () => {
    const en = JSON.parse(getEnJson())
    expect(en.agents?.rotateKey?.confirmBody).toBeDefined()
    expect(en.agents.rotateKey.confirmBody).toContain('{name}')
  })

  test('zh.json contains agents.rotateKey.confirmBody key with {name} interpolation', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.agents?.rotateKey?.confirmBody).toBeDefined()
    expect(zh.agents.rotateKey.confirmBody).toContain('{name}')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — submit button when isSubmitting=true uses t('agents.rotateKey.rotating')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC3: When RotateKeyDialog confirmation submit is in-flight (isSubmitting=true), submit button label is sourced from t('agents.rotateKey.rotating')", () => {
  test("source does NOT contain hardcoded string 'Rotating...' as submit button label", () => {
    const source = getSource()
    const hasHardcodedRotating = source.match(/isSubmitting\s*\?\s*['"]Rotating\.\.\.['"]\s*:/)
    expect(hasHardcodedRotating).toBeNull()
  })

  test("source uses t('agents.rotateKey.rotating') when isSubmitting is true", () => {
    const source = getSource()
    const usesI18nRotating =
      source.match(/isSubmitting\s*\?\s*\{\{\s*t\s*\(\s*['"]agents\.rotateKey\.rotating['"]\s*\)\s*\}\}/) ||
      source.match(/isSubmitting\s*\?\s*t\s*\(\s*['"]agents\.rotateKey\.rotating['"]\s*\)/)
    expect(usesI18nRotating).not.toBeNull()
  })

  test('en.json contains agents.rotateKey.rotating key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.agents?.rotateKey?.rotating).toBeDefined()
  })

  test('zh.json contains agents.rotateKey.rotating key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.agents?.rotateKey?.rotating).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — submit button when idle uses t('common.confirm')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC4: When RotateKeyDialog confirmation submit is idle, submit button label is sourced from t('common.confirm')", () => {
  test("source does NOT contain hardcoded string 'Confirm' as idle submit button label", () => {
    const source = getSource()
    const hasHardcodedConfirm = source.match(/:\s*['"]Confirm['"]\s*\)/)
    expect(hasHardcodedConfirm).toBeNull()
  })

  test("source uses t('common.confirm') when isSubmitting is false", () => {
    const source = getSource()
    const usesI18nConfirm =
      source.match(/:\s*t\s*\(\s*['"]common\.confirm['"]\s*\)\s*\}\}/) ||
      source.match(/isSubmitting\s*\?\s*[^:]*:\s*\{\{\s*t\s*\(\s*['"]common\.confirm['"]\s*\)\s*\}\}/)
    expect(usesI18nConfirm).not.toBeNull()
  })

  test('en.json contains common.confirm key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.common?.confirm).toBeDefined()
  })

  test('zh.json contains common.confirm key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.common?.confirm).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — cancel button uses t('common.cancel')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC5: When RotateKeyDialog cancel button is clicked, button label rendered is sourced from t('common.cancel')", () => {
  test("source does NOT contain hardcoded string 'Cancel' as cancel button label", () => {
    const source = getSource()
    const hasHardcodedCancel = source.match(/>\s*Cancel\s*<\/Button>\s*<!--.*cancel/i) ||
      source.match(/variant=["']outline["']\s*>[\s\n]*Cancel/)
    expect(hasHardcodedCancel).toBeNull()
  })

  test("source uses t('common.cancel') for cancel button", () => {
    const source = getSource()
    const usesI18nCancel =
      source.match(/>\s*\{\{\s*t\s*\(\s*['"]common\.cancel['"]\s*\)\s*\}\}\s*<\/Button>/)
    expect(usesI18nCancel).not.toBeNull()
  })

  test('en.json contains common.cancel key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.common?.cancel).toBeDefined()
  })

  test('zh.json contains common.cancel key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.common?.cancel).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — key-reveal warning paragraph uses t('agents.rotateKey.apiKeyReveal.message')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC6: When RotateKeyDialog key-reveal section is visible, warning paragraph text is sourced from t('agents.rotateKey.apiKeyReveal.message')", () => {
  test("source does NOT contain hardcoded string 'Copy this API key now'", () => {
    const source = getSource()
    const hasHardcodedMessage = source.includes("Copy this API key now")
    expect(hasHardcodedMessage).toBe(false)
  })

  test("source uses t('agents.rotateKey.apiKeyReveal.message') in key-reveal section", () => {
    const source = getSource()
    const keyRevealSection = source.match(/v-if=["']apiKey["'][\s\S]{0,1000}/)
    expect(keyRevealSection).not.toBeNull()
    const usesI18nMessage =
      keyRevealSection?.[0].match(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.message['"]\s*\)/)
    expect(usesI18nMessage).not.toBeNull()
  })

  test('en.json contains agents.rotateKey.apiKeyReveal.message key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.agents?.rotateKey?.apiKeyReveal?.message).toBeDefined()
  })

  test('zh.json contains agents.rotateKey.apiKeyReveal.message key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.agents?.rotateKey?.apiKeyReveal?.message).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — copy button idle state uses t('agents.rotateKey.apiKeyReveal.copy')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC7: When RotateKeyDialog key-reveal copy button is idle, its label is sourced from t('agents.rotateKey.apiKeyReveal.copy')", () => {
  test("source does NOT contain hardcoded string 'Copy' as initial copy button label", () => {
    const source = getSource()
    const hasHardcodedCopy = source.match(/copyButtonText\s*=\s*['"]Copy['"]/)
    expect(hasHardcodedCopy).toBeNull()
  })

  test("source uses t('agents.rotateKey.apiKeyReveal.copy') for initial copy button state", () => {
    const source = getSource()
    const usesI18nCopy =
      source.match(/copyButtonText\s*=\s*ref\s*\(\s*t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.copy['"]\s*\)\s*\)/)
    expect(usesI18nCopy).not.toBeNull()
  })

  test('en.json contains agents.rotateKey.apiKeyReveal.copy key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.agents?.rotateKey?.apiKeyReveal?.copy).toBeDefined()
  })

  test('zh.json contains agents.rotateKey.apiKeyReveal.copy key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.agents?.rotateKey?.apiKeyReveal?.copy).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — copy button activated state uses t('agents.rotateKey.apiKeyReveal.copied')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC8: When RotateKeyDialog key-reveal copy button has been activated, its label switches to t('agents.rotateKey.apiKeyReveal.copied')", () => {
  test("source does NOT contain hardcoded string 'Copied!' when updating copyButtonText", () => {
    const source = getSource()
    const hasHardcodedCopied = source.match(/copyButtonText\.value\s*=\s*['"]Copied!['"]/)
    expect(hasHardcodedCopied).toBeNull()
  })

  test("source uses t('agents.rotateKey.apiKeyReveal.copied') when setting copied state", () => {
    const source = getSource()
    const usesI18nCopied =
      source.match(/copyButtonText\.value\s*=\s*t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.copied['"]\s*\)/)
    expect(usesI18nCopied).not.toBeNull()
  })

  test('en.json contains agents.rotateKey.apiKeyReveal.copied key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.agents?.rotateKey?.apiKeyReveal?.copied).toBeDefined()
  })

  test('zh.json contains agents.rotateKey.apiKeyReveal.copied key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.agents?.rotateKey?.apiKeyReveal?.copied).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — done button uses t('common.done')
// ──────────────────────────────────────────────────────────────────────────────

describe("AC9: When RotateKeyDialog key-reveal done button is rendered, its label is sourced from t('common.done')", () => {
  test("source does NOT contain hardcoded string 'Done' as done button label", () => {
    const source = getSource()
    const keyRevealDoneButton = source.match(/v-if=["']apiKey["'][\s\S]{0,500}>\s*Done\s*<\/Button>/)
    expect(keyRevealDoneButton).toBeNull()
  })

  test("source uses t('common.done') for done button in key-reveal section", () => {
    const source = getSource()
    const keyRevealSection = source.match(/v-if=["']apiKey["'][\s\S]{0,1000}/)
    expect(keyRevealSection).not.toBeNull()
    const usesI18nDone =
      keyRevealSection?.[0].match(/>\s*\{\{\s*t\s*\(\s*['"]common\.done['"]\s*\)\s*\}\}\s*<\/Button>/)
    expect(usesI18nDone).not.toBeNull()
  })

  test('en.json contains common.done key', () => {
    const en = JSON.parse(getEnJson())
    expect(en.common?.done).toBeDefined()
  })

  test('zh.json contains common.done key', () => {
    const zh = JSON.parse(getZhJson())
    expect(zh.common?.done).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('RotateKeyDialog.vue exists', () => {
  test('file is present at components/RotateKeyDialog.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})
