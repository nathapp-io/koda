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

onMounted(async () => {
  try {
    await loadProject()
  } catch (err: unknown) {
    // The engine lists by project id, and a slug that does not resolve is not a filter to guess at:
    // nothing is listed, and the refusal is the message.
    toast.error(extractApiError(err))
    return
  }
  // Names are cosmetic: a failure leaves ids on screen.
  void people.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('approvals.inbox.title')" :subtitle="t('approvals.inbox.subtitleProject')" />
    <ApprovalsApprovalRequestInbox
      v-if="projectId !== null"
      :base="{ kind: 'project', slug, projectId }"
      :name-of="people.nameOf"
    />
  </div>
</template>
