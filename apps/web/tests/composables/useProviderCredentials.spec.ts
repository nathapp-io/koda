/**
 * US-012: the reusable provider-credential store. Every write discriminates saved metadata from an
 * approval request (`permissionKey`), and each composable instance owns its own row list, so the
 * GLOBAL page (US-012) and the project card (US-013) never share a store.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProviderCredentials.ts')

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', scope: 'GLOBAL', projectId: null, repoId: null, providerId: 'openrouter', name: 'Team key',
  last4: 'abcd', fingerprint: '0123456789ab', disabled: false, createdBy: 'u1',
  updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) =>
  ({ records, total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, ...over })
const approval = { id: 'ap1', permissionKey: 'fleet.credential.create', status: 'pending' }

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useProviderCredentials', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load asks for one page of 100 GLOBAL keys and keeps the rows and the pager flag', async () => {
    const get = jest.fn(async () => pageOf([row()], { hasNext: true }))
    withApi({ get })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials()

    expect(vault.credentials.value).toEqual([])
    await vault.load()

    expect(get).toHaveBeenCalledWith('/fleet/provider-credentials', { query: { size: '100' } })
    expect(vault.credentials.value).toEqual([row()])
    expect(vault.hasMore.value).toBe(true)
  })

  test('a project scope reads the project route with the slug as one path segment', async () => {
    const get = jest.fn(async () => pageOf([]))
    withApi({ get })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials({ kind: 'project', slug: 'koda' })

    await vault.load()

    expect(get).toHaveBeenCalledWith('/projects/koda/provider-credentials', { query: { size: '100' } })
  })

  test('create posts { providerId, name, key } and appends the saved row', async () => {
    const created = row({ id: 'c2', providerId: 'anthropic', name: 'Billing A' })
    const post = jest.fn(async () => created)
    withApi({ get: jest.fn(async () => pageOf([row()])), post })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials()
    await vault.load()

    const result = await vault.create({ providerId: 'anthropic', name: 'Billing A', key: 'sk-live-0123456789abcdef' })

    expect(post).toHaveBeenCalledWith('/fleet/provider-credentials', {
      providerId: 'anthropic', name: 'Billing A', key: 'sk-live-0123456789abcdef',
    })
    expect(result).toEqual({ kind: 'saved', credential: created })
    expect(vault.credentials.value.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2'])
  })

  test('a project create may name a repo, and sends repoId only when it has one', async () => {
    const post = jest.fn(async () => row({ scope: 'REPO', repoId: 'r1' }))
    withApi({ get: jest.fn(), post })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials({ kind: 'project', slug: 'koda' })

    await vault.create({ providerId: 'openrouter', name: 'Repo key', key: 'sk-live-0123456789abcdef', repoId: 'r1' })
    await vault.create({ providerId: 'openrouter', name: 'Project key', key: 'sk-live-0123456789abcdef' })

    expect(post).toHaveBeenNthCalledWith(1, '/projects/koda/provider-credentials', {
      providerId: 'openrouter', name: 'Repo key', key: 'sk-live-0123456789abcdef', repoId: 'r1',
    })
    expect(post).toHaveBeenNthCalledWith(2, '/projects/koda/provider-credentials', {
      providerId: 'openrouter', name: 'Project key', key: 'sk-live-0123456789abcdef',
    })
  })

  test('a create answered with an approval request is pending and adds no row', async () => {
    const post = jest.fn(async () => approval)
    withApi({ get: jest.fn(async () => pageOf([row()])), post })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials()
    await vault.load()

    const result = await vault.create({ providerId: 'anthropic', name: 'Billing A', key: 'sk-live-0123456789abcdef' })

    expect(result).toEqual({ kind: 'pending', request: approval })
    expect(vault.credentials.value.map((c: { id: string }) => c.id)).toEqual(['c1'])
  })

  test('rotate patches { key } only and replaces the row', async () => {
    const updated = row({ fingerprint: 'ffffffffffff', last4: 'wxyz' })
    const patch = jest.fn(async () => updated)
    withApi({ get: jest.fn(async () => pageOf([row()])), patch })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials()
    await vault.load()

    const result = await vault.rotate('c1', { key: 'sk-live-0123456789abcdef' })

    expect(patch).toHaveBeenCalledWith('/fleet/provider-credentials/c1', { key: 'sk-live-0123456789abcdef' })
    expect(result).toEqual({ kind: 'saved', credential: updated })
    expect(vault.credentials.value).toEqual([updated])
  })

  test('setDisabled patches a boolean flag and keeps a pending answer out of the rows', async () => {
    const disabled = row({ disabled: true })
    const patch = jest.fn().mockResolvedValueOnce(disabled).mockResolvedValueOnce(approval)
    withApi({ get: jest.fn(async () => pageOf([row()])), patch })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials()
    await vault.load()

    const saved = await vault.setDisabled('c1', true)
    const pending = await vault.setDisabled('c1', false)

    expect(patch).toHaveBeenNthCalledWith(1, '/fleet/provider-credentials/c1', { disabled: true })
    expect(patch).toHaveBeenNthCalledWith(2, '/fleet/provider-credentials/c1', { disabled: false })
    expect(saved).toEqual({ kind: 'saved', credential: disabled })
    expect(pending).toEqual({ kind: 'pending', request: approval })
    // The pending enable left the disabled row alone: the request is not a saved change.
    expect(vault.credentials.value).toEqual([disabled])
  })

  test('remove deletes the row, and a pending delete keeps it', async () => {
    const del = jest.fn().mockResolvedValueOnce({ deleted: true }).mockResolvedValueOnce(approval)
    withApi({ get: jest.fn(async () => pageOf([row(), row({ id: 'c2' })])), delete: del })
    const { useProviderCredentials } = await import(composablePath)
    const vault = useProviderCredentials()
    await vault.load()

    const deleted = await vault.remove('c1')
    const pending = await vault.remove('c2')

    expect(del).toHaveBeenNthCalledWith(1, '/fleet/provider-credentials/c1')
    expect(del).toHaveBeenNthCalledWith(2, '/fleet/provider-credentials/c2')
    expect(deleted).toEqual({ kind: 'deleted' })
    expect(pending).toEqual({ kind: 'pending', request: approval })
    expect(vault.credentials.value.map((c: { id: string }) => c.id)).toEqual(['c2'])
  })

  test('two instances keep separate row stores, so GLOBAL and project rows never mix (US-013)', async () => {
    const get = jest.fn(async (path: string) =>
      path === '/fleet/provider-credentials' ? pageOf([row()]) : pageOf([row({ id: 'p1', scope: 'PROJECT', projectId: 'proj' })]))
    withApi({ get })
    const { useProviderCredentials } = await import(composablePath)
    const global = useProviderCredentials()
    const project = useProviderCredentials({ kind: 'project', slug: 'koda' })

    await global.load()
    await project.load()

    expect(global.credentials.value.map((c: { id: string }) => c.id)).toEqual(['c1'])
    expect(project.credentials.value.map((c: { id: string }) => c.id)).toEqual(['p1'])
  })
})
