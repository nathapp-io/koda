import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n } from '../helpers/fleet-harness'

const component = webFile('components', 'fleet', 'FleetJobAgentResult.vue')

describe('FleetJobAgentResult', () => {
  const mount = (agentResult: unknown) => mountSfc(component, {
    props: { agentResult },
    globals: { useI18n: () => enI18n() },
  })

  test('AC-3: completed status and multiline output render translated status as preformatted text', () => {
    const m = mount({ status: 'completed', output: 'line 1\nline 2', truncated: false, deniedAsks: [], deniedAsksTruncated: false })
    expect(m.text()).toContain('Completed')
    expect(m.one('pre')).toBeDefined()
    expect(m.one('pre')?.children[0]?.text).toBe('line 1\nline 2')
    expect(m.one('pre')?.props.class).toContain('whitespace-pre-wrap')
    m.unmount()
  })

  test.each([
    ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['timeout', 'Timed out'],
  ] as const)('shows translated %s status', (status, label) => {
    const m = mount({ status, output: '', truncated: false, deniedAsks: [], deniedAsksTruncated: false })
    expect(m.text()).toContain(label)
    m.unmount()
  })

  test('AC-4: output containing HTML is literal text and creates no element', () => {
    const m = mount({ status: 'completed', output: '<b>x</b>', truncated: false, deniedAsks: [], deniedAsksTruncated: false })
    expect(m.text()).toContain('<b>x</b>')
    expect(m.one('b')).toBeUndefined()
    m.unmount()
  })

  test('AC-5: output truncation is announced', () => {
    const m = mount({ status: 'completed', output: 'tail', truncated: true, deniedAsks: [], deniedAsksTruncated: false })
    expect(m.text()).toContain('Output was truncated.')
    m.unmount()
  })

  test('AC-6: denied approval and question asks are both listed', () => {
    const m = mount({
      status: 'failed', output: '', truncated: false,
      deniedAsks: [{ kind: 'approval', tool: 'Bash', summary: 'rm -rf x' }, { kind: 'question', text: 'Which?' }],
      deniedAsksTruncated: false,
    })
    expect(m.text()).toContain('Bash')
    expect(m.text()).toContain('rm -rf x')
    expect(m.text()).toContain('Which?')
    m.unmount()
  })

  test('AC-7: unpriced result shows cost unknown notice', () => {
    const m = mount({ status: 'completed', output: '', truncated: false, deniedAsks: [], deniedAsksTruncated: false })
    expect(m.text()).toContain('Cost unavailable')
    m.unmount()
  })

  test('AC-8: null result shows pending notice', () => {
    const m = mount(null)
    expect(m.text()).toContain('Agent result is pending.')
    m.unmount()
  })
})
