/**
 * Permissions P1 US-010 (AC-3 to AC-8, AC-10): the role editor, mounted for real. The real
 * `useRoles` runs over a fake `$api`, so each assertion is on the HTTP call the editor makes.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { mountSfc, webFile, type Mounted, type FakeNode } from '../helpers/mount-sfc'
import { uiStubs, enI18n, enLocale } from '../helpers/fleet-harness'
import { CATALOG, fakeApi, role, settle, type FakeApi } from '../helpers/roles-fixtures'
import { allById, byId, call, typeInto } from '../helpers/roles-dom'
import * as apiModule from '../../composables/useApi'
import { ApiError, extractApiError } from '../../composables/useApi'
import { useRoles } from '../../composables/useRoles'
import type { Role } from '../../composables/useRoles'

const dialogPath = webFile('components', 'RoleEditorDialog.vue')

interface Mount { app: Mounted; api: FakeApi; toast: { error: jest.Mock; success: jest.Mock } }

async function mountDialog(props: { role: Role | null }, apiOver: Partial<FakeApi> = {}): Promise<Mount> {
  const api = fakeApi([], apiOver)
  const toast = { error: jest.fn(), success: jest.fn() }
  ;(globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
  const app = mountSfc(dialogPath, {
    props: { open: true, ...props },
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: { useI18n: () => enI18n(), useAppToast: () => toast, useRoles },
  })
  await settle()
  return { app, api, toast }
}

const rowKeys = (app: Mounted): string[] => allById(app, 'matrix-row').map((n) => String(n.props['data-key']))
const chipEntries = (app: Mounted): string[] => allById(app, 'entry-chip').map((n) => String(n.props['data-entry']))
const copy = (key: string): string => {
  const value = key.split('.').reduce<unknown>((n, p) => (n as Record<string, unknown> | undefined)?.[p], enLocale)
  expect(typeof value).toBe('string')
  return value as string
}

function check(app: Mounted, key: string, checked = true): void {
  call(byId(app, `perm-${key}`), 'onChange', { target: { checked } })
}

function choose(app: Mounted, key: string, choice: 'none' | 'own' | 'any'): void {
  call(byId(app, `perm-${key}-${choice}`), 'onChange', { target: {} })
}

async function submit(m: Mount): Promise<void> {
  call(byId(m.app, 'role-form'), 'onSubmit')
  await settle()
}

async function fillNew(m: Mount): Promise<void> {
  typeInto(byId(m.app, 'role-key'), 'qa-lead')
  typeInto(byId(m.app, 'role-name'), 'QA Lead')
  await settle()
}

beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

describe('AC-3: the matrix shows the catalog entries that fit a new PROJECT role', () => {
  test('only project and any entries render, grouped by first segment, each with its risk badge', async () => {
    const m = await mountDialog({ role: null })

    expect(m.api.get).toHaveBeenCalledWith('/permissions/catalog')
    expect(rowKeys(m.app).sort()).toEqual(
      ['comment.update', 'fleet.job.read', 'ticket.create', 'ticket.delete', 'ticket.read'],
    )
    expect(rowKeys(m.app)).not.toContain('role.manage')
    expect(rowKeys(m.app)).not.toContain('user.read')
    expect(allById(m.app, 'matrix-group').map((g) => g.props['data-group'])).toEqual(['comment', 'fleet', 'ticket'])

    const ticketGroup = allById(m.app, 'matrix-group').find((g) => g.props['data-group'] === 'ticket') as FakeNode
    expect(allById(m.app, 'matrix-row', ticketGroup).map((r) => r.props['data-key'])).toEqual(['ticket.create', 'ticket.delete', 'ticket.read'])

    const deleteRow = allById(m.app, 'matrix-row').find((r) => r.props['data-key'] === 'ticket.delete') as FakeNode
    const badge = byId(m.app, 'risk-badge', deleteRow)
    expect(badge.props['data-risk']).toBe('high')
    expect(m.app.textOf(badge)).toBe(copy('admin.roles.risk.high'))
  })

  test('switching a new role to GLOBAL swaps the rows to global and any entries', async () => {
    const m = await mountDialog({ role: null })

    call(byId(m.app, 'role-scope'), 'onChange', { target: { value: 'GLOBAL' } })
    await settle()

    expect(rowKeys(m.app).sort()).toEqual(['fleet.job.read', 'role.manage', 'user.read'])
  })

  test('the ownable row is a three-way choice and the others are checkboxes', async () => {
    const m = await mountDialog({ role: null })

    expect(byId(m.app, 'perm-ticket.create').props.type).toBe('checkbox')
    for (const choice of ['none', 'own', 'any']) expect(byId(m.app, `perm-comment.update-${choice}`).props.type).toBe('radio')
  })
})

describe('AC-4: a new role saves checked keys and own choices, sorted', () => {
  test('ticket.create checked and comment.update own posts both, sorted', async () => {
    const m = await mountDialog({ role: null })

    await fillNew(m)
    check(m.app, 'ticket.create')
    choose(m.app, 'comment.update', 'own')
    await settle()
    await submit(m)

    expect(m.api.post).toHaveBeenCalledTimes(1)
    expect(m.api.post).toHaveBeenCalledWith('/roles', {
      key: 'qa-lead', name: 'QA Lead', description: '', scope: 'PROJECT',
      permissions: ['comment.update.own', 'ticket.create'],
    })
    expect(m.app.emitted('saved')).toHaveLength(1)
    expect(m.app.emitted('update:open')).toEqual([[false]])
  })

  test('choosing any writes the bare key; choosing none afterwards removes it', async () => {
    const m = await mountDialog({ role: null })

    await fillNew(m)
    choose(m.app, 'comment.update', 'any')
    check(m.app, 'ticket.read')
    await settle()
    expect(byId(m.app, 'perm-comment.update-any').props.checked).toBe(true)
    await submit(m)
    expect(m.api.post).toHaveBeenLastCalledWith('/roles', expect.objectContaining({ permissions: ['comment.update', 'ticket.read'] }))

    choose(m.app, 'comment.update', 'none')
    check(m.app, 'ticket.read', false)
    await settle()
    await submit(m)
    expect(m.api.post).toHaveBeenLastCalledWith('/roles', expect.objectContaining({ permissions: [] }))
  })

  test('a key that does not match ROLE_KEY_PATTERN is refused before any request', async () => {
    const m = await mountDialog({ role: null })

    typeInto(byId(m.app, 'role-key'), 'Bad Key')
    typeInto(byId(m.app, 'role-name'), 'Whatever')
    await settle()
    await submit(m)

    expect(m.api.post).not.toHaveBeenCalled()
    expect(m.app.text()).toContain(copy('admin.roles.form.keyFormat'))
  })
})

const savedRole = (): Role => role({
  permissions: ['*.read', 'ticket.create'],
  expandedKeys: ['ticket.read', 'ticket.create', 'comment.update'],
})

describe('AC-5: a saved role shows wildcard chips and covered rows', () => {
  test('*.read is a chip, ticket.read is checked and disabled, ticket.create is checked and enabled', async () => {
    const m = await mountDialog({ role: savedRole() })

    expect(chipEntries(m.app)).toEqual(['*.read'])
    const covered = byId(m.app, 'perm-ticket.read')
    expect(covered.props.checked).toBe(true)
    expect(covered.props.disabled).toBe(true)
    const explicit = byId(m.app, 'perm-ticket.create')
    expect(explicit.props.checked).toBe(true)
    expect(explicit.props.disabled).toBeFalsy()
    expect(byId(m.app, 'perm-ticket.delete').props.checked).toBe(false)
  })

  test('an explicit X.own entry shows as own and stays editable when the role covers X as well', async () => {
    const m = await mountDialog({
      role: role({ permissions: ['comment.update.own'], expandedKeys: ['comment.update.own'] }),
    })

    expect(byId(m.app, 'perm-comment.update-own').props.checked).toBe(true)
    expect(byId(m.app, 'perm-comment.update-own').props.disabled).toBeFalsy()
    expect(byId(m.app, 'perm-comment.update-any').props.checked).toBe(false)
  })
})

describe('AC-6: chips are removable and a text input adds entries', () => {
  test('removing *.read and adding ticket.transition.* patches chips first, then checked keys', async () => {
    const m = await mountDialog({ role: savedRole() })

    call(byId(m.app, 'entry-remove', allById(m.app, 'entry-chip')[0]), 'onClick')
    typeInto(byId(m.app, 'entry-input'), 'ticket.transition.*')
    await settle()
    call(byId(m.app, 'entry-add'), 'onClick')
    await settle()
    expect(chipEntries(m.app)).toEqual(['ticket.transition.*'])
    await submit(m)

    expect(m.api.patch).toHaveBeenCalledTimes(1)
    const [path, body] = m.api.patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/roles/r1')
    expect(body.permissions).toEqual(['ticket.transition.*', 'ticket.create'])
  })

  test('chips keep their stored order and exclusions are chips too', async () => {
    const m = await mountDialog({ role: role({ permissions: ['!ticket.delete', 'prefix.*', 'ticket.read'], expandedKeys: [] }) })

    expect(chipEntries(m.app)).toEqual(['!ticket.delete', 'prefix.*'])
    await submit(m)

    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body.permissions).toEqual(['!ticket.delete', 'prefix.*', 'ticket.read'])
  })

  test('a blank or duplicate entry adds nothing', async () => {
    const m = await mountDialog({ role: savedRole() })

    typeInto(byId(m.app, 'entry-input'), '   ')
    call(byId(m.app, 'entry-add'), 'onClick')
    typeInto(byId(m.app, 'entry-input'), '*.read')
    call(byId(m.app, 'entry-add'), 'onClick')
    await settle()

    expect(chipEntries(m.app)).toEqual(['*.read'])
  })
})

describe('AC-7: a locked role opens read-only', () => {
  test('every editor field is disabled and there is no save or delete button', async () => {
    const m = await mountDialog({ role: role({ locked: true, system: true, permissions: ['*.read', 'ticket.create'], expandedKeys: ['ticket.read'] }) })

    const fields = [
      ...m.app.find('input'), ...m.app.find('select'), ...m.app.find('textarea'),
      ...m.app.find('[data-stub="input"]'), ...m.app.find('[data-stub="textarea"]'),
    ]
    expect(fields.length).toBeGreaterThan(5)
    for (const field of fields) expect(field.props.disabled).toBe(true)
    expect(allById(m.app, 'entry-remove').every((n) => n.props.disabled === true)).toBe(true)
    expect(allById(m.app, 'role-save')).toHaveLength(0)
    expect(allById(m.app, 'role-delete')).toHaveLength(0)
  })

  test('submitting a locked role sends nothing', async () => {
    const m = await mountDialog({ role: role({ locked: true }) })

    await submit(m)

    expect(m.api.patch).not.toHaveBeenCalled()
  })

  test('an editable role does show a save button', async () => {
    const m = await mountDialog({ role: role() })

    expect(allById(m.app, 'role-save')).toHaveLength(1)
  })
})

describe('AC-8: a system role keeps its name', () => {
  test('the name input is disabled and the PATCH body has no name', async () => {
    const m = await mountDialog({ role: role({ system: true, name: 'Developer', permissions: ['ticket.read'] }) })

    expect(byId(m.app, 'role-name').props.disabled).toBe(true)
    expect(byId(m.app, 'role-description').props.disabled).toBeFalsy()
    await submit(m)

    expect(m.api.patch).toHaveBeenCalledTimes(1)
    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body).not.toHaveProperty('name')
    expect(body.permissions).toEqual(['ticket.read'])
  })

  test('a custom role sends its name', async () => {
    const m = await mountDialog({ role: role() })

    await submit(m)

    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body.name).toBe('QA')
  })

  test('key and scope are create-only fields', async () => {
    const edit = await mountDialog({ role: role() })
    expect(allById(edit.app, 'role-key')).toHaveLength(0)
    expect(allById(edit.app, 'role-scope')).toHaveLength(0)

    const create = await mountDialog({ role: null })
    expect(allById(create.app, 'role-key')).toHaveLength(1)
    expect(allById(create.app, 'role-scope')).toHaveLength(1)
  })
})

describe('AC-10: a refused save keeps the dialog open', () => {
  test('a 403 permissions.escalation toasts extractApiError(err) and keeps the entered values', async () => {
    const err = new ApiError(40003, 'permissions.escalation')
    const m = await mountDialog({ role: null }, { post: jest.fn(async () => { throw err }) as never })

    await fillNew(m)
    check(m.app, 'ticket.create')
    await settle()
    await submit(m)

    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.emitted('update:open')).toHaveLength(0)
    expect(m.app.emitted('saved')).toHaveLength(0)
    expect(byId(m.app, 'role-key').props.modelValue).toBe('qa-lead')
    expect(byId(m.app, 'role-name').props.modelValue).toBe('QA Lead')
    expect(byId(m.app, 'perm-ticket.create').props.checked).toBe(true)
  })

  test('the catalog fixture is non-empty (guard against a vacuous matrix)', () => {
    expect(CATALOG.length).toBeGreaterThan(0)
  })
})

describe('fix round 1 F1: saving before the catalog arrives cannot erase permissions', () => {
  test('while the catalog request is pending, save is disabled and a submit sends nothing', async () => {
    let release: (entries: typeof CATALOG) => void = () => undefined
    const pending = new Promise<typeof CATALOG>((resolve) => { release = resolve })
    const m = await mountDialog({ role: savedRole() }, {
      get: jest.fn(async (path: string) => (path === '/permissions/catalog' ? pending : [])) as never,
    })

    expect(byId(m.app, 'role-save').props.disabled).toBe(true)
    typeInto(byId(m.app, 'role-description'), 'changed')
    await settle()
    await submit(m)
    expect(m.api.patch).not.toHaveBeenCalled()

    release(CATALOG)
    await settle()
    expect(byId(m.app, 'role-save').props.disabled).toBeFalsy()
    await submit(m)

    expect(m.api.patch).toHaveBeenCalledTimes(1)
    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body.description).toBe('changed')
    expect(body.permissions).toEqual(['*.read', 'ticket.create'])
  })

  test('a failed catalog load still unlocks save and keeps every stored entry', async () => {
    const m = await mountDialog({ role: savedRole() }, {
      get: jest.fn(async () => { throw new ApiError(50000, 'down') }) as never,
    })

    expect(byId(m.app, 'role-save').props.disabled).toBeFalsy()
    await submit(m)

    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body.permissions).toEqual(['*.read', 'ticket.create'])
  })
})

describe('fix round 1 F2: covered rows come from the saved entries, not the current choices', () => {
  test('unchecking a saved explicit checkbox leaves it unchecked and enabled, and the PATCH drops it', async () => {
    const m = await mountDialog({ role: savedRole() })

    check(m.app, 'ticket.create', false)
    await settle()
    expect(byId(m.app, 'perm-ticket.create').props.checked).toBe(false)
    expect(byId(m.app, 'perm-ticket.create').props.disabled).toBeFalsy()

    check(m.app, 'ticket.create', true)
    await settle()
    expect(byId(m.app, 'perm-ticket.create').props.checked).toBe(true)

    check(m.app, 'ticket.create', false)
    await settle()
    await submit(m)
    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body.permissions).toEqual(['*.read'])
  })

  test('choosing none on a saved bare ownable permission stays none and editable, and the PATCH drops it', async () => {
    const m = await mountDialog({ role: role({ permissions: ['comment.update'], expandedKeys: ['comment.update'] }) })

    choose(m.app, 'comment.update', 'none')
    await settle()
    expect(byId(m.app, 'perm-comment.update-none').props.checked).toBe(true)
    expect(byId(m.app, 'perm-comment.update-any').props.checked).toBe(false)
    expect(byId(m.app, 'perm-comment.update-none').props.disabled).toBeFalsy()

    choose(m.app, 'comment.update', 'own')
    await settle()
    await submit(m)
    const body = (m.api.patch.mock.calls[0] as [string, Record<string, unknown>])[1]
    expect(body.permissions).toEqual(['comment.update.own'])
  })

  test('a wildcard-covered row stays covered while other rows change', async () => {
    const m = await mountDialog({ role: savedRole() })

    check(m.app, 'ticket.create', false)
    await settle()

    expect(byId(m.app, 'perm-ticket.read').props.checked).toBe(true)
    expect(byId(m.app, 'perm-ticket.read').props.disabled).toBe(true)
  })
})
