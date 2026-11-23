import { describe, expect, it } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const table = webFile('components', 'ui', 'table', 'Table.vue')

 describe('Table region semantics (US-008)', () => {
  it('AC-7: a named table wrapper is a focusable region', () => {
    const app = mountSfc(table, { props: { regionLabel: 'Approval policies' } })
    const wrapper = app.one('div')
    expect(wrapper?.props.role).toBe('region')
    expect(wrapper?.props['aria-label']).toBe('Approval policies')
    expect(wrapper?.props.tabindex).toBe(0)
  })

  it('AC-8: an unnamed table wrapper has no region or focus attributes', () => {
    const app = mountSfc(table)
    const wrapper = app.one('div')
    expect(wrapper?.props.role).toBeUndefined()
    expect(wrapper?.props['aria-label']).toBeUndefined()
    expect(wrapper?.props.tabindex).toBeUndefined()
  })
})
