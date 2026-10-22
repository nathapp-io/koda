/** Small tree-walking helpers for the Admin -> Roles specs (mount-sfc's FakeNode tree). */
import { nextTick } from 'vue'
import type { FakeNode, Mounted } from './mount-sfc'

export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await nextTick()
  }
}

/** The one node carrying `data-testid`, failing loudly when it is missing. */
export function byId(app: Mounted, id: string, scope?: FakeNode): FakeNode {
  const found = app.find(`[data-testid="${id}"]`, scope)[0]
  expect(found).toBeDefined()
  return found as FakeNode
}

export function allById(app: Mounted, id: string, scope?: FakeNode): FakeNode[] {
  return app.find(`[data-testid="${id}"]`, scope)
}

export function call(target: FakeNode, event: string, arg: unknown = { target: {}, preventDefault: () => undefined }): void {
  const fn = target.props[event]
  expect(fn).toBeInstanceOf(Function)
  ;(fn as (e: unknown) => unknown)(arg)
}

export function typeInto(target: FakeNode, value: string): void {
  call(target, 'onUpdate:modelValue', value)
}
