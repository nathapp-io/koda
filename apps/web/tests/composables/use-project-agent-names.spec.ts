import { describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const file = webFile('composables', 'useProjectAgentNames.ts')

describe('useProjectAgentNames', () => {
  test('loads the project roster through useApi and resolves agent ids by name', async () => {
    const get = jest.fn(async () => ({ items: [{ id: 'agent-1', name: 'Probe Bot', slug: 'probe' }] }))
    const mounted = mountSfc(file, { globals: { useApi: () => ({ $api: { get } }) } })
    const names = mounted.exports.useProjectAgentNames('web') as {
      load: () => Promise<void>
      nameOf: (id: string) => string | null
    }
    await names.load()
    expect(get).toHaveBeenCalledWith('/projects/web/agents')
    expect(names.nameOf('agent-1')).toBe('Probe Bot')
    expect(names.nameOf('agent-2')).toBeNull()
  })
})
