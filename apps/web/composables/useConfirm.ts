import { computed, shallowRef } from 'vue'

export interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; destructive?: boolean }
interface Pending { options: ConfirmOptions; resolve: (ok: boolean) => void }

// One dialog per tab. Client-only: confirm() is called from event handlers, never during setup or SSR.
const pending = shallowRef<Pending | null>(null)

export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    pending.value?.resolve(false)
    return new Promise<boolean>((resolve) => { pending.value = { options, resolve } })
  }

  function settle(ok: boolean): void {
    const current = pending.value
    if (!current) return
    pending.value = null
    current.resolve(ok)
  }

  return { confirm, settle, current: computed(() => pending.value?.options ?? null) }
}
