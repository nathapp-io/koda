import { describe, test, expect, afterEach, jest } from '@jest/globals'
import { join } from 'path'
import { ApiError } from '../../composables/useApi'
import { enI18n, toastRecorder } from '../helpers/fleet-harness'
import type { ScheduleDto } from '../../lib/fleet-types'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetScheduleActions.ts')
const s = { id: 's1', name: 'nightly' } as ScheduleDto

function setup(confirmResult = true) {
  const toasts = toastRecorder()
  const g = globalThis as Record<string, unknown>
  g.useI18n = () => enI18n()
  g.useAppToast = () => toasts
  g.window = { confirm: jest.fn(() => confirmResult) }
  const api = {
    enable: jest.fn(async () => ({ ...s, enabled: true })),
    disable: jest.fn(async () => ({ ...s, enabled: false })),
    remove: jest.fn(async () => undefined),
  }
  const onStale = jest.fn()
  return { toasts, api, onStale }
}

afterEach(() => {
  for (const key of ['useI18n', 'useAppToast', 'window']) delete (globalThis as Record<string, unknown>)[key]
})

describe('useFleetScheduleActions', () => {
  test('enable and disable call the api and toast success', async () => {
    const { toasts, api, onStale } = setup()
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.setEnabled(s, true)).toEqual(expect.objectContaining({ enabled: true }))
    expect(await actions.setEnabled(s, false)).toEqual(expect.objectContaining({ enabled: false }))
    expect(toasts.successes).toEqual(['Schedule enabled', 'Schedule disabled'])
    expect(onStale).not.toHaveBeenCalled()
    expect(actions.busy.value).toBe(false)
  })

  test('a refused enable (409 owner lost access) shows the server message and reloads (D223)', async () => {
    const { toasts, api, onStale } = setup()
    api.enable.mockImplementationOnce(async () => { throw new ApiError(409, 'The schedule owner can no longer dispatch') })
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.setEnabled(s, true)).toBeNull()
    expect(toasts.errors).toEqual(['The schedule owner can no longer dispatch'])
    expect(onStale).toHaveBeenCalledTimes(1)
    expect(actions.busy.value).toBe(false)
  })

  test('delete asks first; a refusal of the dialog does nothing', async () => {
    const { api, onStale } = setup(false)
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.remove(s)).toBe(false)
    expect(api.remove).not.toHaveBeenCalled()
  })

  test('delete confirmed: removes, toasts, answers true; a 404 toasts and reloads', async () => {
    const { toasts, api, onStale } = setup(true)
    const { useFleetScheduleActions } = await import(composablePath)
    const actions = useFleetScheduleActions(api as never, onStale)
    expect(await actions.remove(s)).toBe(true)
    expect(toasts.successes).toEqual(['Schedule deleted'])
    expect((globalThis as { window: { confirm: jest.Mock } }).window.confirm)
      .toHaveBeenCalledWith('Delete schedule nightly? The jobs it dispatched are kept.')

    api.remove.mockImplementationOnce(async () => { throw new ApiError(404, 'Schedule not found') })
    expect(await actions.remove(s)).toBe(false)
    expect(toasts.errors).toEqual(['Schedule not found'])
    expect(onStale).toHaveBeenCalledTimes(1)
  })
})
