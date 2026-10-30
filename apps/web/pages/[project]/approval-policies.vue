<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import ApprovalPolicyDialog from '~/components/approvals/ApprovalPolicyDialog.vue'
import ApprovalPolicyList from '~/components/approvals/ApprovalPolicyList.vue'
import ApprovableKeysTable from '~/components/approvals/ApprovableKeysTable.vue'
import { extractApiError } from '~/composables/useApi'
import { useApprovalPolicies } from '~/composables/useApprovalPolicies'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { isIncompletePolicyListError } from '~/lib/approval-policies'
import type { ApprovalPolicy, PolicyBase } from '~/lib/approval-policies'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const route = useRoute()
const slug = String(route.params.project)
const { permissions } = useProjectPermissions(slug)
const canRead = computed(() => permissions.value.has('approval.policy.read'))
const canManage = computed(() => permissions.value.has('approval.policy.manage'))
const base: PolicyBase = { kind: 'project', slug }
const { policies, keys, pending, list, loadKeys, remove } = useApprovalPolicies(base)

const loaded = ref(false)
const loadFailed = ref(false)
const incomplete = ref(false)
const loadForbidden = ref(false)
const forbidden = computed(() => !canRead.value || loadForbidden.value)
const editorOpen = ref(false)
const editing = ref<ApprovalPolicy | null>(null)

async function reload(): Promise<void> {
  try {
    await Promise.all([list(), loadKeys()])
    loaded.value = true
    loadFailed.value = false
    incomplete.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      loadForbidden.value = true
      return
    }
    if (isIncompletePolicyListError(err)) {
      incomplete.value = true
      return
    }
    loadFailed.value = true
    toast.error(extractApiError(err))
  }
}

let attempted = false
async function gate(): Promise<void> {
  if (attempted || !canRead.value) return
  attempted = true
  await reload()
}
watch(canRead, () => { void gate() }, { immediate: true })

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
    toast.error(extractApiError(err))
    return
  }
  await reload()
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('approvals.policies.project.title')" :subtitle="t('approvals.policies.subtitle')">
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
      <p v-else-if="incomplete" class="text-sm text-muted-foreground" data-testid="policies-incomplete">
        {{ t('approvals.policies.incomplete') }}
      </p>
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
