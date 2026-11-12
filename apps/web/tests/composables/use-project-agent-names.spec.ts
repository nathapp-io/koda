import { describe, expect, jest, test } from '@jest/globals'
import { useProjectAgentNames } from '../../composables/useProjectAgentNames'

describe('useProjectAgentNames', () => {
  test('loads the project roster through useApi and resolves ids by roster name', async () => {
    const get = jest.fn(async () => ({ items: [{ id: 'agent-1', name: 'Probe Bot', slug: 'probe' }] }))
    const globals = globalThis as typeof globalThis & { useApi?: () => { $api: { get: typeof get } } }
    globals.useApi = () => ({ $api: { get } })
    try {
      const names = useProjectAgentNames('web')
      await names.load()
      expect(get).toHaveBeenCalledWith('/projects/web/agents')
      expect(names.nameOf('agent-1')).toBe('Probe Bot')
      expect(names.nameOf('agent-2')).toBeNull()
    }
    finally {
      delete globals.useApi
    }
  })
})
