<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetRepo } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { repos, hasMore, pending, checks, projects, load, loadProjects, check, checkAll, remove } = useFleetRepos()

const adminOnly = ref(false)
const addOpen = ref(false)

// ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

const projectLabel = computed(() => new Map(projects.value.map((p) => [p.id, p.slug])))

function repoName(repo: FleetRepo): string {
  return `${repo.owner}/${repo.name}`
}

function dispatchHref(repo: FleetRepo): string | null {
  const slug = projectLabel.value.get(repo.projectId)
  return slug ? `/${slug}/fleet/dispatch?repoId=${encodeURIComponent(repo.id)}` : null
}

/** Loads the rows; false (after a toast or the admin-only note) when that failed. */
async function loadRows(): Promise<boolean> {
  try {
    await load()
    return true
  } catch (err: unknown) {
    if (isForbidden(err)) adminOnly.value = true
    else toast.error(extractApiError(err))
    return false
  }
}

/**
 * A reachability check is a live call to the forge, so mounting this page must not fan out one
 * request per row: with 100 rows that spends the installation's whole hourly App budget, and again
 * on every visit. Rows therefore start unchecked and the admin asks for checks explicitly.
 */
const checkingAll = ref(false)

async function onCheckAll(): Promise<void> {
  checkingAll.value = true
  try {
    await checkAll()
  } finally {
    checkingAll.value = false
  }
}

/**
 * The rows and the project labels only. `checkAll` is deliberately not called here; see onCheckAll.
 */
async function reload(): Promise<void> {
  if (!(await loadRows())) return
  // The project list only labels rows; a failure there leaves the ids showing.
  await loadProjects().catch((err: unknown) => toast.error(extractApiError(err)))
}

/** A new repo: reload the rows (the dialog has its own composable instance) and check only the new one. */
async function onCreated(repo: FleetRepo): Promise<void> {
  if (await loadRows()) await check(repo.id)
}

async function confirmDelete(repo: FleetRepo): Promise<void> {
  if (!window.confirm(t('fleet.repos.deleteConfirm', { repo: repoName(repo) }))) return
  try {
    await remove(repo.id)
    toast.success(t('fleet.repos.toast.deleted'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(() => reload())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.repos.title')" :subtitle="t('fleet.repos.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="adminOnly || checkingAll" @click="onCheckAll">
          {{ checkingAll ? t('fleet.repos.reach.checking') : t('fleet.repos.actions.checkAll') }}
        </Button>
        <Button :disabled="adminOnly" @click="addOpen = true">
          <Plus class="mr-2 h-4 w-4" />{{ t('fleet.repos.actions.add') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <LoadingState v-if="pending && repos.length === 0" />
      <EmptyState v-else-if="repos.length === 0" :message="t('fleet.repos.empty')" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.repos.table.repo') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.project') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.provider') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.branch') }}</TableHead>
            <TableHead>{{ t('fleet.repos.table.reachability') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="repo in repos" :key="repo.id" :data-testid="`fleet-repo-${repo.owner}-${repo.name}`">
            <TableCell class="font-medium">{{ repoName(repo) }}</TableCell>
            <TableCell>{{ projectLabel.get(repo.projectId) ?? repo.projectId }}</TableCell>
            <TableCell>{{ t(`fleet.repos.provider.${repo.provider}`) }}</TableCell>
            <TableCell>{{ repo.defaultBranch }}</TableCell>
            <TableCell><FleetRepoReachabilityBadge :state="checks[repo.id]" /></TableCell>
            <TableCell class="space-x-1 whitespace-nowrap text-right">
              <NuxtLink v-if="dispatchHref(repo)" :to="dispatchHref(repo)!" class="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs hover:bg-muted" :data-testid="`fleet-repo-dispatch-${repo.owner}-${repo.name}`">
                {{ t('fleet.repos.actions.dispatch') }}
              </NuxtLink>
              <Button size="sm" variant="outline" :disabled="checks[repo.id]?.status === 'checking'" @click="check(repo.id)">
                {{ t('fleet.repos.actions.recheck') }}
              </Button>
              <Button size="sm" variant="destructive" @click="confirmDelete(repo)">{{ t('fleet.repos.actions.delete') }}</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-if="hasMore" class="text-sm text-muted-foreground">{{ t('fleet.common.more', { n: FLEET_LIST_SIZE }) }}</p>
    </template>

    <FleetAddRepoDialog v-model:open="addOpen" :projects="projects" @created="onCreated" />
  </div>
</template>
