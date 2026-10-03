<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { scopeName } from '~/lib/fleet-budgets'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload } from '~/lib/fleet-approvals'

definePageMeta({ layout: 'default' })

const base: ApprovalBase = { kind: 'admin' }
const viewer: ApprovalViewer = { kind: 'admin' }
const { t } = useI18n()
const repos = useFleetRepos()
const runnersApi = useFleetRunners()
const usersApi = useAdminUsers()
const forbidden = ref(false)

// D251: lookups are cosmetic; a failure leaves ids or the fallback on screen.
const slugOf = (projectId: string): string | null => repos.projects.value.find((p) => p.id === projectId)?.slug ?? null
const projectName = (projectId: string | null): string =>
  projectId === null ? t('fleet.approvals.noProject') : (slugOf(projectId) ?? projectId)
const jobLink = (projectId: string, jobId: string): string | null => {
  const slug = slugOf(projectId)
  return slug === null ? null : `/${slug}/fleet/jobs/${jobId}`
}
const runnerName = (id: string): string => runnersApi.runners.value.find((r) => r.id === id)?.name ?? id
const scopeLabel = (p: BudgetApprovalPayload): string | null =>
  p.scopeType === 'project' && p.scopeId !== null
    ? projectName(p.scopeId)
    : scopeName(p, { project: null, repo: (id) => id, runner: runnerName })
const nameOf = (userId: string): string | null => {
  const user = usersApi.users.value.find((u) => u.id === userId)
  return user ? (user.name || user.email) : null
}

onMounted(() => {
  void repos.loadProjects().catch(() => undefined)
  void runnersApi.load().catch(() => undefined)
  void usersApi.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.approvals.title')" :subtitle="t('fleet.approvals.subtitleAdmin')" />
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-approvals-admin-only">{{ t('fleet.common.adminOnly') }}</p>
    <FleetApprovalInbox
      v-else
      :base="base"
      :viewer="viewer"
      :scope-label="scopeLabel"
      :name-of="nameOf"
      :job-link="jobLink"
      :project-name="projectName"
      @forbidden="forbidden = true"
    />
  </div>
</template>
