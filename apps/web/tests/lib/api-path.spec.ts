import { describe, expect, it } from '@jest/globals'
import { apiPath } from '~/lib/api-path'

describe('apiPath', () => {
  it('keeps the literal parts and encodes each interpolated value', () => {
    const slug = 'koda'
    const ref = 'KODA-12'
    expect(apiPath`/projects/${slug}/tickets/${ref}/comments`).toBe('/projects/koda/tickets/KODA-12/comments')
  })

  it.each([
    ['a/b', 'a%2Fb'],
    ['a?b=1', 'a%3Fb%3D1'],
    ['a#b', 'a%23b'],
    ['a b', 'a%20b'],
    ['50%', '50%25'],
    ['中文', '%E4%B8%AD%E6%96%87'],
  ])('encodes %p as one path segment', (value, encoded) => {
    expect(apiPath`/projects/${value}/labels`).toBe(`/projects/${encoded}/labels`)
  })

  it('keeps a code-intel symbol id (with / and ::) in one segment', () => {
    const id = 'proj1:repo1:src/app/main.ts::fn:boot'
    expect(apiPath`/code-intel/symbols/${id}/callers`).toBe(
      '/code-intel/symbols/proj1%3Arepo1%3Asrc%2Fapp%2Fmain.ts%3A%3Afn%3Aboot/callers',
    )
  })

  it('accepts numbers', () => {
    expect(apiPath`/projects/${'koda'}/vcs/sync/${42}`).toBe('/projects/koda/vcs/sync/42')
  })

  it('returns a template with no values unchanged', () => {
    expect(apiPath`/agents`).toBe('/agents')
  })

  it.each([[''], [undefined], [null]])('throws on an empty value (%p) instead of building //', (value) => {
    expect(() => apiPath`/projects/${value as unknown as string}/tickets`).toThrow('apiPath: empty value')
  })
})
