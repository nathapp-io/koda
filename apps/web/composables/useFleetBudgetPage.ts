import { ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

/** ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue). */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

/**
 * State shared by the admin and project budgets pages (D177): the list with its load/stale/forbidden
 * flags, the create/edit and resume dialog state, and delete. Pages add only their names, their live
 * refresh source and their template.
 */
export function useFleetBudgetPage(base: BudgetBase) {
  const { t } = useI18n()
  const toast = useAppToast()
  const budgets = useFleetBudgets(base)

  const loaded = ref(false)
  const pending = ref(true)
  const loadFailed = ref(false)
  const stale = ref(false)
  const forbidden = ref(false)

  const editOpen = ref(false)
  const editing = ref<BudgetPolicyDto | null>(null)
  const resumeOpen = ref(false)
  const resuming = ref<BudgetPolicyDto | null>(null)

  /** The first load reports; a failed poll keeps the last rows and marks them stale. */
  async function refresh(): Promise<void> {
    try {
      await budgets.load()
      loaded.value = true
      loadFailed.value = false
      stale.value = false
    } catch (err: unknown) {
      if (isForbidden(err)) {
        forbidden.value = true
      } else if (loaded.value) {
        stale.value = true
      } else {
        loadFailed.value = true
        toast.error(extractApiError(err))
      }
    } finally {
      pending.value = false
    }
  }

  function openCreate(): void {
    editing.value = null
    editOpen.value = true
  }

  function openEdit(policy: BudgetPolicyDto): void {
    editing.value = policy
    editOpen.value = true
  }

  function openResume(policy: BudgetPolicyDto): void {
    resuming.value = policy
    resumeOpen.value = true
  }

  /** D186: the confirm text says what deleting a paused policy does. A refusal reloads the list (D185). */
  async function remove(policy: BudgetPolicyDto, confirmText: string): Promise<void> {
    if (!window.confirm(confirmText)) return
    try {
      await budgets.remove(policy.id)
      toast.success(t('fleet.budgets.toast.deleted'))
    } catch (err: unknown) {
      toast.error(extractApiError(err))
      void refresh()
    }
  }

  function onApplied(saved: BudgetPolicyDto): void {
    budgets.apply(saved)
  }

  return {
    policies: budgets.policies, pending, loadFailed, stale, forbidden,
    editOpen, editing, resumeOpen, resuming,
    refresh, openCreate, openEdit, openResume, remove, onApplied,
  }
}
