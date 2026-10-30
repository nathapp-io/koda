<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { t } = useI18n()
const repos = useFleetRepos()
const users = useAdminUsers()

/** A user requester's name; an id the first page of users does not hold shows as the id (D251). */
const nameOf = (userId: string): string | null => {
  const user = users.users.value.find((candidate) => candidate.id === userId)
  return user ? (user.name || user.email) : null
}

/** `/approvals` lists requests of every project, so the row names the project from the project list. */
const projectName = (projectId: string): string =>
  repos.projects.value.find((project) => project.id === projectId)?.slug ?? projectId

onMounted(() => {
  // Both lookups are cosmetic: a failure leaves ids on screen, it never fails the inbox.
  void repos.loadProjects().catch(() => undefined)
  void users.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('approvals.inbox.title')" :subtitle="t('approvals.inbox.subtitle')" />
    <ApprovalsApprovalRequestInbox :base="{ kind: 'all' }" :name-of="nameOf" :project-name="projectName" />
  </div>
</template>
