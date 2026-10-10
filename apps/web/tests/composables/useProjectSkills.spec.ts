import { describe, test, expect, afterEach, jest } from '@jest/globals'
import { useProjectSkills } from '../../composables/useProjectSkills'

const skill = (id: string, enabled: boolean) => ({
  id, name: `${id}-name`, description: 'd', enabled,
  source: { id: 'src1', gitUrl: 'https://github.com/o/r', ref: 'main', resolvedSha: '0123456789abcdef', status: 'OK' },
})

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
})

describe('useProjectSkills (US-007)', () => {
  test('US-007 list: gets the project skills route and returns the response items array', async () => {
    const get = jest.fn(async () => ({ items: [skill('alpha', false), skill('beta', true)] }))
    withApi({ get })

    const items = await useProjectSkills().list('web')

    expect(get).toHaveBeenCalledWith('/projects/web/skills')
    expect(items).toEqual([skill('alpha', false), skill('beta', true)])
  })

  test('US-007 list (guard): returns an empty array when items is not an array', async () => {
    withApi({ get: jest.fn(async () => ({ items: 'oops' })) })

    await expect(useProjectSkills().list('web')).resolves.toEqual([])
  })

  test('US-007 AC4: enable sends PUT to the project skill route and returns the enabled skill', async () => {
    const put = jest.fn(async () => skill('alpha', true))
    withApi({ put })

    const enabled = await useProjectSkills().enable('web', 'alpha')

    expect(put).toHaveBeenCalledWith('/projects/web/skills/alpha')
    expect(enabled.enabled).toBe(true)
  })

  test('US-007 AC5: disable sends DELETE to the project skill route', async () => {
    const del = jest.fn(async () => ({}))
    withApi({ delete: del })

    await useProjectSkills().disable('web', 'alpha')

    expect(del).toHaveBeenCalledWith('/projects/web/skills/alpha')
  })

  test('US-007 (encoding): slug and skill id stay one path segment', async () => {
    const put = jest.fn(async () => skill('x', true))
    withApi({ put })

    await useProjectSkills().enable('a/b', 'c d')

    expect(put).toHaveBeenCalledWith('/projects/a%2Fb/skills/c%20d')
  })

  test('US-007 (error path): a rejected enable propagates the API error to the caller', async () => {
    const { ApiError } = await import('../../composables/useApi')
    const forbidden = new ApiError(403, 'Forbidden')
    withApi({ put: jest.fn(async () => { throw forbidden }) })

    await expect(useProjectSkills().enable('web', 'alpha')).rejects.toBe(forbidden)
  })
})
