import { describe, test, expect, jest } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs } from '../helpers/fleet-harness'
import { ref, computed } from 'vue'
import type { FleetRepo } from '../../lib/fleet-types'
const repo: FleetRepo = { id: 'r1', projectId: 'p', provider: 'gitlab', owner: 'org', name: 'repo', defaultBranch: 'main', githubInstallationId: null, autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null, fixTrustDetectedChecks: false, fixAllowUnprotected: false, ruleOverride: { sha256: 'a'.repeat(64), ruleFiles: 2, rulesMode: 'merge', contextMode: null, updatedAt: '' }, createdAt: '' }
describe('FleetRepoRuleOverrideDialog', () => {
  test('shows the override open button with its file count', () => {
    const getRuleOverride = jest.fn(async () => ({ rules: [{ path: 'api.md', content: 'body' }], rulesMode: 'replace' as const, context: null, sha256: 'a'.repeat(64), updatedAt: '' }))
    const app = mountSfc(webFile('components', 'fleet', 'RepoRuleOverrideDialog.vue'), { components: uiStubs, props: { repo }, globals: { ref, computed, useI18n: () => ({ t: (k: string, p?: { files?: number }) => p?.files ? `${k} ${p.files}` : k }), useGlobalPermissions: () => ({ permissions: { value: { has: () => true } } }) }, alias: { '~/composables/useApi': { extractApiError: () => 'error' }, '~/composables/useFleetRepos': { useFleetRepos: () => ({ getRuleOverride, setRuleOverride: jest.fn(), clearRuleOverride: jest.fn() }) } } })
    expect(app.text()).toContain('fleet.repos.ruleOverride.open 2')
    app.unmount()
  })
})
