import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const settingsPath = join(webDir, 'pages', '[project]', 'settings.vue')
const vcsCardPath = join(webDir, 'components', 'SettingsVcsCard.vue')

const pageSource = readFileSync(settingsPath, 'utf-8')
const cardSource = readFileSync(vcsCardPath, 'utf-8')
// Slice 5 split the settings page into form components; the VCS assertions now
// read the page + VCS card as one surface (slice-1 precedent — assertions
// unchanged in intent, only in what they read).
const source = `${pageSource}\n${cardSource}`
const en = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'en.json'), 'utf-8'))
const zh = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'zh.json'), 'utf-8'))

describe('Track 3 Slice 4: VCS settings', () => {
  test('offers GitLab as a provider', () => {
    expect(source).toContain('<SelectItem value="gitlab">')
  })

  test('disables webhook sync for GitLab', () => {
    expect(source).toMatch(/value="webhook"[^>]*:disabled="values\.provider === 'gitlab'"/)
  })

  test('shows the returned webhook secret with a copy button', () => {
    expect(source).toContain('data-testid="webhook-secret"')
    expect(source).toContain('navigator.clipboard.writeText')
    expect(source).toContain('webhookSecret')
  })

  test('rotates the secret through the API', () => {
    expect(source).toContain('/vcs/webhook-secret/rotate')
  })

  test('does not surface the secret for a polling-only GitLab connection', () => {
    expect(source).toContain("saved?.provider !== 'gitlab'")
  })

  test.each([
    'form.providerGitlab', 'form.gitlabPollingOnly',
    'secret.title', 'secret.onceNotice', 'secret.copy', 'secret.copied', 'secret.copyFailed', 'secret.rotate', 'secret.rotateConfirm',
  ])('en and zh both define vcs.%s', (key) => {
    const read = (locale: Record<string, unknown>) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale.vcs)
    expect(typeof read(en)).toBe('string')
    expect(typeof read(zh)).toBe('string')
  })
})
