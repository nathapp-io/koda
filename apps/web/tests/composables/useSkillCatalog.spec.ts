import { describe, test, expect, afterEach, jest } from '@jest/globals'
import { useSkillCatalog } from '../../composables/useSkillCatalog'

const source = (id: string) => ({
  id, gitUrl: 'https://github.com/o/r', ref: 'main', path: 'skills', resolvedSha: null, resolvedAt: null,
  status: 'OK', statusReason: null, createdAt: '2026-10-01T00:00:00Z', skills: [],
})

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).useApi
})

describe('useSkillCatalog (US-006)', () => {
  test('US-006 AC1: create posts the JSON body { gitUrl, ref, path } to the admin sources route', async () => {
    const post = jest.fn(async () => source('src1'))
    withApi({ post })

    const created = await useSkillCatalog().create({ gitUrl: 'https://github.com/o/r', ref: 'main', path: 'skills' })

    expect(post).toHaveBeenCalledWith('/admin/skills/sources', { gitUrl: 'https://github.com/o/r', ref: 'main', path: 'skills' })
    expect(created.id).toBe('src1')
  })

  test('US-006 AC2: list gets the admin sources route and returns the response items array', async () => {
    const get = jest.fn(async () => ({ items: [source('a'), source('b')] }))
    withApi({ get })

    const sources = await useSkillCatalog().list()

    expect(get).toHaveBeenCalledWith('/admin/skills/sources')
    expect(sources).toEqual([source('a'), source('b')])
  })

  test('US-006 AC3: update posts to the source update route and returns the source', async () => {
    const post = jest.fn(async () => source('src1'))
    withApi({ post })

    const updated = await useSkillCatalog().update('src1')

    expect(post).toHaveBeenCalledWith('/admin/skills/sources/src1/update', {})
    expect(updated.id).toBe('src1')
  })

  test('US-006 AC4: remove deletes the source route', async () => {
    const del = jest.fn(async () => ({}))
    withApi({ delete: del })

    await useSkillCatalog().remove('src1')

    expect(del).toHaveBeenCalledWith('/admin/skills/sources/src1')
  })

  test('US-006: a rejected create propagates the API error to the caller', async () => {
    const { ApiError } = await import('../../composables/useApi')
    const conflict = new ApiError(409, 'Skill source already registered')
    withApi({ post: jest.fn(async () => { throw conflict }) })

    await expect(useSkillCatalog().create({ gitUrl: 'https://github.com/o/r', ref: 'main', path: '' })).rejects.toBe(conflict)
  })
})
