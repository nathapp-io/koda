import { ApiError } from '~/composables/useApi'
import { checkProjectRoute } from '~/lib/project-route-check'

describe('checkProjectRoute', () => {
  it('AC-5: returns known when the slug is cached', async () => {
    await expect(checkProjectRoute('web', { known: ['web'], fetchProject: jest.fn() })).resolves.toBe('known')
  })

  it('AC-6: does not fetch a known slug', async () => {
    const fetchProject = jest.fn<Promise<unknown>, [string]>()
    await checkProjectRoute('web', { known: ['web'], fetchProject })
    expect(fetchProject).toHaveBeenCalledTimes(0)
  })

  it('AC-7: returns found when the project fetch succeeds', async () => {
    const fetchProject = jest.fn<Promise<unknown>, [string]>().mockResolvedValue({ slug: 'web' })
    await expect(checkProjectRoute('web', { known: [], fetchProject })).resolves.toBe('found')
  })

  it('AC-8: returns notFound for an API not-found rejection', async () => {
    const fetchProject = jest.fn<Promise<unknown>, [string]>().mockRejectedValue(new ApiError(40004, 'gone'))
    await expect(checkProjectRoute('nope', { known: [], fetchProject })).resolves.toBe('notFound')
  })

  it('AC-9: returns unverified for other API failures', async () => {
    const fetchProject = jest.fn<Promise<unknown>, [string]>().mockRejectedValue(new ApiError(50000, 'down'))
    await expect(checkProjectRoute('web', { known: [], fetchProject })).resolves.toBe('unverified')
  })

  it('AC-10: skips routes without a string slug', async () => {
    const fetchProject = jest.fn<Promise<unknown>, [string]>()
    await expect(checkProjectRoute(undefined, { known: [], fetchProject })).resolves.toBe('skip')
  })
})
