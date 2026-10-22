/**
 * Permissions P1 US-012 (AC-4 / fix round 1, F2): every gated agent action surfaces the API's own
 * refusal.
 *
 * The web rule is "a gate only hides or disables a control; every refusal from the API is still
 * shown with `toast.error(extractApiError(err))`". These dialogs used to toast a generic
 * "Failed to …" string, which threw away the API's reason (a permission refusal and a validation
 * refusal looked identical). Each case here rejects the write and asserts the mounted dialog toasts
 * exactly what `extractApiError` extracts, and emits nothing — the action did not happen.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { mountSfc, webFile, type FakeNode, type Mounted } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { byId, call, settle } from '../helpers/roles-dom'
import { ApiError, extractApiError } from '../../composables/useApi'

const agent = {
  id: 'a1',
  name: 'Agent A1',
  slug: 'agent-a1',
  roles: ['DEVELOPER'],
  capabilities: ['code.write'],
  status: 'ACTIVE' as const,
}

interface Mount {
  app: Mounted
  toast: { success: jest.Mock; error: jest.Mock }
}

function mountDialog(file: string, api: Record<string, jest.Mock>): Mount {
  const toast = { success: jest.fn(), error: jest.fn() }
  const app = mountSfc(file, {
    props: { open: true, agent },
    components: uiStubs,
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
    },
  })
  return { app, toast }
}

const throwing = (err: unknown) => jest.fn(async () => { throw err })

/** The single form the dialog renders (the confirm step, before any key was revealed). */
const formOf = (app: Mounted): FakeNode => {
  const forms = app.find('form')
  expect(forms).toHaveLength(1)
  return forms[0] as FakeNode
}

beforeEach(() => {
  const host = globalThis as Record<string, unknown>
  delete host.useApi
  delete host.useAsyncData
})

afterEach(() => {
  const host = globalThis as Record<string, unknown>
  delete host.useApi
  delete host.useAsyncData
})

describe('F2: a refused rotate-key', () => {
  test('toasts the extracted API error and emits no rotated', async () => {
    const err = new ApiError(40003, 'You may not rotate this key')
    const post = throwing(err)
    const m = mountDialog(webFile('components', 'RotateKeyDialog.vue'), { post })

    call(formOf(m.app), 'onSubmit')
    await settle()

    expect(post).toHaveBeenCalledTimes(1)
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.emitted().map(([name]) => name)).not.toContain('rotated')
  })
})

describe('F2: a refused capability update', () => {
  test('toasts the extracted API error and emits no updated', async () => {
    const err = new ApiError(40003, 'You may not change this agent')
    const patch = throwing(err)
    const m = mountDialog(webFile('components', 'EditAgentCapabilitiesDialog.vue'), { patch })

    call(formOf(m.app), 'onSubmit', { preventDefault: () => undefined })
    await settle()

    expect(patch).toHaveBeenCalledTimes(1)
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.emitted().map(([name]) => name)).not.toContain('updated')
  })
})

describe('F2: a refused delete', () => {
  test('toasts the extracted API error and emits no deleted', async () => {
    const err = new ApiError(409, 'This agent still has 2 open tickets')
    const del = throwing(err)
    const m = mountDialog(webFile('components', 'DeleteAgentDialog.vue'), { delete: del })

    call(byId(m.app, 'agent-delete-confirm'), 'onClick')
    await settle()

    expect(del).toHaveBeenCalledTimes(1)
    expect(m.toast.error).toHaveBeenCalledWith(extractApiError(err))
    expect(m.app.emitted().map(([name]) => name)).not.toContain('deleted')
  })
})
