<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { scopeName } from '~/lib/fleet-budgets'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload } from '~/lib/fleet-approvals'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const base: ApprovalBase = { kind: 'project', slug }
const { t } = useI18n()
const { data: role } = useProjectViewerRole(slug)
const people = useProjectMemberNames(slug)
const options = useFleetDispatchOptions(slug)

// D244: canManage is project ADMIN, and a global ADMIN resolves to project ADMIN.
const viewer = computed<ApprovalViewer>(() => ({ kind: 'project', canManage: role.value.canManage }))
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
