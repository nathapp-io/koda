import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { uiStubs } from '../helpers/fleet-harness'
import { ref } from 'vue'

describe('FleetRepoAutoReview', () => {
  test('renders stored profiles when auto-review is enabled', () => {
    const app = mountSfc(webFile('components', 'fleet', 'RepoAutoReview.vue'), {
      components: uiStubs,
      props: { repo: { id: 'r1', provider: 'github', githubInstallationId: '7', autoReview: true, autoReviewProfiles: ['native-ds', 'review'], autoReviewMaxCostUsd: '2.5000' } },
      globals: { ref, useI18n: () => ({ t: (key: string) => key }), useGlobalPermissions: () => ({ permissions: { value: { has: () => true } } }), useApi: () => ({ $api: { patch: async () => ({}) } }) },
      alias: { '~/composables/useApi': { extractApiError: (err: unknown) => String(err) } },
    })
    expect(app.text()).toContain('native-ds')
    expect(app.text()).toContain('review')
    app.unmount()
  })
})
