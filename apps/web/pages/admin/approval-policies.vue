<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import ApprovalPolicyDialog from '~/components/approvals/ApprovalPolicyDialog.vue'
import ApprovalPolicyList from '~/components/approvals/ApprovalPolicyList.vue'
import ApprovableKeysTable from '~/components/approvals/ApprovableKeysTable.vue'
import { extractApiError } from '~/composables/useApi'
import { useApprovalPolicies } from '~/composables/useApprovalPolicies'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import type { ApprovalPolicy, PolicyBase } from '~/lib/approval-policies'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { permissions } = useGlobalPermissions()

/** Both the reads and the writes of the global routes need this one key (7a). */
const canManage = computed(() => permissions.value.has('approval.policy.manage'))

const base: PolicyBase = { kind: 'global' }
const { policies, keys, pending, list, loadKeys, remove } = useApprovalPolicies(base)

const loaded = ref(false)
const loadFailed = ref(false)
/** A 403 on the load means the same thing as a missing key: this page is not yours. */
const loadForbidden = ref(false)
const forbidden = computed(() => !canManage.value || loadForbidden.value)

const editorOpen = ref(false)
const editing = ref<ApprovalPolicy | null>(null)

async function reload(): Promise<void> {
  try {
    await Promise.all([list(), loadKeys()])
    loaded.value = true
    loadFailed.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      loadForbidden.value = true
      return
    }
    loadFailed.value = true
    toast.error(extractApiError(err))
  }
}

/**
 * The page asks for nothing without `approval.policy.manage`: not the list, not the keys. The gate
 * runs again when the keys arrive, so a client-side navigation into the page still loads it.
 */
let attempted = false
async function gate(): Promise<void> {
  if (attempted || !canManage.value) return
  attempted = true
  await reload()
}
watch(canManage, () => { void gate() }, { immediate: true })

function openCreate(): void {
  editing.value = null
  editorOpen.value = true
}

function openEdit(policy: ApprovalPolicy): void {
  editing.value = policy
  editorOpen.value = true
}

async function onDelete(policy: ApprovalPolicy): Promise<void> {
  if (!window.confirm(t('approvals.policies.list.deleteConfirm', { pattern: policy.permissionPattern }))) return
  try {
    await remove(policy.id)
    toast.success(t('approvals.policies.toast.deleted'))
  } catch (err: unknown) {
    // The list keeps its last loaded state, so the policy stays listed.
    toast.error(extractApiError(err))
    return
  }
  await reload()
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('approvals.policies.title')" :subtitle="t('approvals.policies.subtitle')">
      <template #actions>
        <Button v-if="canManage && !forbidden" data-testid="policy-create" @click="openCreate">
          <Plus class="mr-2 h-4 w-4" />{{ t('approvals.policies.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="policies-forbidden">
      {{ t('approvals.policies.forbidden') }}
    </p>
    <template v-else>
      <LoadingState v-if="pending && !loaded" />
      <p v-else-if="loadFailed" class="text-sm text-status-rejected" data-testid="policies-load-failed">
        {{ t('approvals.policies.loadFailed') }}
      </p>
      <template v-else>
        <ApprovableKeysTable :keys="keys" :policies="policies" />
        <section class="space-y-2">
          <h2 class="text-sm font-semibold">{{ t('approvals.policies.list.title') }}</h2>
          <ApprovalPolicyList
            :base="base"
            :policies="policies"
            :can-manage="canManage"
            @edit="openEdit"
            @remove="onDelete"
          />
        </section>
      </template>
    </template>

    <ApprovalPolicyDialog
      v-model:open="editorOpen"
      :base="base"
      :policy="editing"
      :keys="keys"
      @saved="reload"
    />
  </div>
</template>
