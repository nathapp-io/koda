import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const panel = () => readFileSync(join(webDir, 'components', 'ProjectMembersPanel.vue'), 'utf-8')
const settings = () => readFileSync(join(webDir, 'pages', '[project]', 'settings.vue'), 'utf-8')

describe('Slice 4: project members panel', () => {
  test('loads through useProjectMembers(slug) on mount', () => {
    expect(panel()).toContain('useProjectMembers(props.slug)')
    expect(panel()).toMatch(/onMounted\(/)
  })

  test('management controls are gated by canManageMembers', () => {
    expect(panel()).toContain('canManageMembers(')
    expect(panel()).toMatch(/v-if="canManage"/)
  })

  test('removal asks for confirmation', () => {
    expect(panel()).toContain("t('projects.members.removeConfirm'")
    expect(panel()).toContain('window.confirm(')
  })

  test('settings renders the panel in the project tab', () => {
    expect(settings()).toMatch(/<ProjectMembersPanel :slug="slug" \/>/)
  })
})
