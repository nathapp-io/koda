<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { scopeName } from '~/lib/fleet-budgets'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload } from '~/lib/fleet-approvals'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const base: ApprovalBase = { kind: 'project', slug }
const { t } = useI18n()
const auth = useAuth()
const people = useProjectMemberNames(slug)
const options = useFleetDispatchOptions(slug)

// Permissions P1 US-009: each approval kind has the key its decide route requires, so the viewer carries
// both of them from the project's set. 2aw-D6: an assistant_action is decided by its requester alone, so the
// viewer also carries the signed-in user id.
const { permissions } = useProjectPermissions(slug)
const viewer = computed<ApprovalViewer>(() => ({
  kind: 'project',
  userId: auth.user.value?.id ?? null,
  canDecideBudget: permissions.value.has('fleet.approval.decide.budget'),
  canDecideBash: permissions.value.has('fleet.approval.decide.bash'),
}))
const scopeLabel = (p: BudgetApprovalPayload): string | null =>
  scopeName(p, { project: slug, repo: options.repoName, runner: (id) => id })
// A project inbox holds only this project's approvals (D230), so every candidate is a job of this project.
const jobLink = (_projectId: string, jobId: string): string => `/${slug}/fleet/jobs/${jobId}`

onMounted(() => {
  // Names are cosmetic: a failure leaves ids or the fallback on screen.
  void people.load().catch(() => undefined)
  void options.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.approvals.title')" :subtitle="t('fleet.approvals.subtitleProject')" />
    <FleetApprovalInbox :base="base" :viewer="viewer" :scope-label="scopeLabel" :name-of="people.nameOf" :job-link="jobLink" />
  </div>
</template>
