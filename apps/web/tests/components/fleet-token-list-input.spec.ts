import { describe, expect, test } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const component = webFile('components', 'fleet', 'FleetTokenListInput.vue')

function mount(suggestions: string[], groupByPrefix = false) {
  return mountSfc(component, {
    components: uiStubs,
    props: { modelValue: [], suggestions, testId: 'profiles', groupByPrefix },
    globals: { ref, useI18n: () => enI18n() },
  })
}

const suggestions = (app: ReturnType<typeof mountSfc>) => app.find('[data-testid="profiles-suggestion"]')

describe('FleetTokenListInput suggestions', () => {
  test('filters suggestion buttons as the draft is typed', async () => {
    const app = mount(['native-ds', 'codex-review'])
    const input = app.find('[data-testid="profiles-input"]')[0]
    ;(input.props['onUpdate:modelValue'] as (value: string) => void)('native')
    await Promise.resolve()
    expect(suggestions(app).map(button => app.textOf(button))).toEqual(['+ native-ds'])
    app.unmount()
  })

  test('groups suggestions with sorted accessible names and translated Other heading', () => {
    const app = mount(['native-ds', 'codex-review', 'fast'], true)
    const groups = app.find('[role="group"]')
    expect(groups.map(group => group.props['aria-label'])).toEqual(['codex', 'native', 'Other'])
    expect(groups.map(group => app.textOf(group).startsWith(String(group.props['aria-label'])))).toEqual([true, true, true])
    app.unmount()
  })

  test('keeps suggestions flat unless grouping is opted in', () => {
    const app = mount(['native-ds', 'codex-review'])
    expect(app.find('[role="group"]')).toHaveLength(0)
    app.unmount()
  })
})
