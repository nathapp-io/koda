<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { useProjectRef } from '~/composables/useProjectRef'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const people = useProjectMemberNames(slug)
const { id: projectId, load: loadProject } = useProjectRef(slug)

const loadFailed = ref(false)

async function resolveProject(): Promise<void> {
  loadFailed.value = false
  try {
    await loadProject()
  } catch (err: unknown) {
    // The engine lists by project id, and a slug that does not resolve is not a filter to guess at:
    // nothing is listed, the refusal is the message, and Retry asks again.
    loadFailed.value = true
    toast.error(extractApiError(err))
    return
  }
  // Names are cosmetic: a failure leaves ids on screen.
  void people.load().catch(() => undefined)
}

onMounted(resolveProject)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('approvals.inbox.title')" :subtitle="t('approvals.inbox.subtitleProject')" />
    <div v-if="loadFailed" class="space-y-3">
      <p class="text-sm text-status-rejected" data-testid="approvals-project-load-failed">{{ t('approvals.inbox.loadFailed') }}</p>
      <Button variant="outline" size="sm" data-testid="approvals-project-retry" @click="resolveProject()">{{ t('common.retry') }}</Button>
    </div>
    <ApprovalsApprovalRequestInbox
      v-else-if="projectId !== null"
      :base="{ kind: 'project', slug, projectId }"
      :name-of="people.nameOf"
    />
  </div>
</template>
