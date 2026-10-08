import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const mount = (props: Record<string, unknown>) =>
  mountSfc(webFile('components', 'fleet', 'config', 'RepoConfigList.vue'), { props, components: uiStubs, globals: { useI18n: () => enI18n() } })
const repo = (id: string, owner: string, name: string) => ({ id, projectId: 'p', provider: 'github', owner, name, defaultBranch: 'main', githubInstallationId: '1', createdAt: '' })

describe('RepoConfigList', () => {
  test('one row per repo with a link to its config page, sorted by owner/name', () => {
    const app = mount({ slug: 'p', repos: [repo('r2', 'zeta', 'svc'), repo('r1', 'acme', 'app')] })
    const links = app.find('[data-testid="fleet-repo-config-link"]')
    expect(links.map((l) => l.props.to)).toEqual(['/p/fleet/repos/r1/config', '/p/fleet/repos/r2/config'])
    expect(app.text()).toContain('acme/app')
  })

  test('renders nothing when the project has no fleet repos', () => {
    expect(mount({ slug: 'p', repos: [] }).find('[data-testid="fleet-repo-config-card"]')).toHaveLength(0)
  })
})
