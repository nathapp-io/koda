<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import type { SkillSourceDto } from '~/composables/useSkillCatalog'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { list, update, remove } = useSkillCatalog()

const sources = ref<SkillSourceDto[]>([])
const pending = ref(false)
const adminOnly = ref(false)
const addOpen = ref(false)
const expanded = ref<Record<string, boolean>>({})

// ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

async function load(): Promise<void> {
  pending.value = true
  try {
    sources.value = await list()
  } catch (err: unknown) {
    if (isForbidden(err)) adminOnly.value = true
    else toast.error(extractApiError(err))
  } finally {
    pending.value = false
  }
}

/** The short sha shown in the table; an unresolved source has none. */
function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '—'
}

function replaceSource(next: SkillSourceDto): void {
  sources.value = sources.value.map((s) => (s.id === next.id ? next : s))
}

async function onUpdate(source: SkillSourceDto): Promise<void> {
  try {
    replaceSource(await update(source.id))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

async function onRemove(source: SkillSourceDto): Promise<void> {
  if (!window.confirm(t('skills.confirm.remove', { url: source.gitUrl }))) return
  try {
    await remove(source.id)
    sources.value = sources.value.filter((s) => s.id !== source.id)
    toast.success(t('skills.toast.removed'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

function onCreated(source: SkillSourceDto): void {
  sources.value = [...sources.value, source]
}

function toggleSkills(source: SkillSourceDto): void {
  expanded.value = { ...expanded.value, [source.id]: !expanded.value[source.id] }
}

onMounted(() => load())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('skills.page.title')" :subtitle="t('skills.page.subtitle')">
      <template #actions>
        <Button v-if="!adminOnly" @click="addOpen = true">
          <Plus class="mr-2 h-4 w-4" />{{ t('skills.actions.add') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('skills.adminOnly') }}</p>

    <template v-else>
      <LoadingState v-if="pending && sources.length === 0" />
      <EmptyState v-else-if="sources.length === 0" :message="t('skills.empty')" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('skills.table.url') }}</TableHead>
            <TableHead>{{ t('skills.table.ref') }}</TableHead>
            <TableHead>{{ t('skills.table.sha') }}</TableHead>
            <TableHead>{{ t('skills.table.path') }}</TableHead>
            <TableHead>{{ t('skills.table.status') }}</TableHead>
            <TableHead>{{ t('skills.table.skills') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="source in sources" :key="source.id">
            <TableRow :data-testid="`skill-source-${source.id}`">
              <TableCell class="font-medium">{{ source.gitUrl }}</TableCell>
              <TableCell>{{ source.ref }}</TableCell>
              <TableCell class="font-mono text-xs">{{ shortSha(source.resolvedSha) }}</TableCell>
              <TableCell>{{ source.path }}</TableCell>
              <TableCell>
                <Badge v-if="source.status === 'RESOLVE_FAILED'" variant="destructive">
                  {{ t('skills.status.failed') }}: {{ source.statusReason }}
                </Badge>
                <Badge v-else variant="secondary">{{ t('skills.status.ok') }}</Badge>
              </TableCell>
              <TableCell>{{ source.skills.length }}</TableCell>
              <TableCell class="space-x-1 whitespace-nowrap text-right">
                <Button size="sm" variant="outline" @click="toggleSkills(source)">{{ t('skills.actions.showSkills') }}</Button>
                <Button size="sm" variant="outline" @click="onUpdate(source)">{{ t('skills.actions.update') }}</Button>
                <Button size="sm" variant="destructive" @click="onRemove(source)">{{ t('skills.actions.remove') }}</Button>
              </TableCell>
            </TableRow>
            <TableRow v-if="expanded[source.id]">
              <TableCell colspan="7">
                <ul class="space-y-2">
                  <li v-for="skill in source.skills" :key="skill.id">
                    <div class="text-sm font-medium">{{ skill.name }}</div>
                    <div class="text-sm text-muted-foreground">{{ skill.description }}</div>
                  </li>
                </ul>
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </Table>
    </template>

    <AddSkillSourceDialog v-model:open="addOpen" @created="onCreated" />
  </div>
</template>
