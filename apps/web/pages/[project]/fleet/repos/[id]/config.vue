<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto } from '~/lib/fleet-types'
import {
  createFile, deleteFile, discardAll, discardFile, draftEdits, draftProblems, editFile, emptyDraft, groupFiles,
  newFileTargets, reapplyEdits, resolveConflict, type ConfigDraft, type NaxFileContent, type NaxFileList,
} from '~/lib/nax-config'
import NaxFileTree from '~/components/fleet/config/NaxFileTree.vue'
import NaxFileEditor from '~/components/fleet/config/NaxFileEditor.vue'
import NaxChangesPanel from '~/components/fleet/config/NaxChangesPanel.vue'
import ConfigPrDialog from '~/components/fleet/config/ConfigPrDialog.vue'
import NewNaxFileDialog from '~/components/fleet/config/NewNaxFileDialog.vue'

definePageMeta({ layout: 'default' })

/** S3 §6: browse a fleet repo's allowlisted .nax/ files and turn edits into a CONFIG_EDIT job (D474: draft = page state). */
const route = useRoute()
const slug = route.params.project as string
const repoId = route.params.id as string
const reopenJobId = typeof route.query.reopen === 'string' && route.query.reopen !== '' ? route.query.reopen : null
const { t } = useI18n()
const toast = useAppToast()
const configApi = useFleetRepoConfig(slug)
const options = useFleetDispatchOptions(slug)
const { data: viewerRole } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewerRole.value))

const list = ref<NaxFileList | null>(null)
const loaded = ref<Record<string, NaxFileContent>>({})
const tooLarge = ref<readonly string[]>([])
const draft = ref<ConfigDraft>(emptyDraft(''))
const selected = ref<string | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const unreachable = ref<string | null>(null)
const busy = ref(false)
const submitted = ref(false)
const prDialog = ref(false)
const newFileDialog = ref(false)
const activeJob = ref<FleetJobDto | null>(null)

const groups = computed(() => (list.value ? groupFiles(list.value.files, draft.value) : []))
const existingPaths = computed(() => [...new Set([...(list.value?.files.map((f) => f.path) ?? []), ...Object.keys(draft.value.files)])])
const targets = computed(() => (list.value ? newFileTargets(list.value.files) : []).filter((p) => !existingPaths.value.includes(p)))
const edits = computed(() => draftEdits(draft.value))
const problems = computed(() => draftProblems(draft.value))
const canSave = computed(() => canWork.value && edits.value.length > 0 && problems.value.length === 0 && !busy.value)
const selectedDraft = computed(() => (selected.value ? draft.value.files[selected.value] : undefined))
const selectedTooLarge = computed(() => selected.value !== null && tooLarge.value.includes(selected.value))
const selectedContent = computed((): string | null => {
  const path = selected.value
  if (!path) return null
  if (selectedDraft.value) return selectedDraft.value.content
  return loaded.value[path]?.content ?? null
})

async function loadContent(path: string): Promise<void> {
  const current = list.value
  if (!current || loaded.value[path] || !current.files.some((f) => f.path === path)) return
  try {
    const content = await configApi.read(repoId, path, current.baseSha)
    loaded.value = { ...loaded.value, [path]: content }
  }
  catch (err: unknown) {
    if (err instanceof ApiError && err.code === 422) tooLarge.value = [...tooLarge.value, path]
    else toast.error(extractApiError(err))
  }
}

async function reopen(jobId: string, latest: NaxFileList): Promise<void> {
  const stored = await configApi.jobEdits(jobId)
  const paths = stored.edits.map((e) => e.path).filter((p) => latest.files.some((f) => f.path === p))
  const contents = await Promise.all(paths.map((p) => configApi.read(repoId, p, latest.baseSha)))
  loaded.value = Object.fromEntries(contents.map((c) => [c.path, c]))
  draft.value = reapplyEdits(stored.edits, latest, loaded.value)
}

async function load(): Promise<void> {
  pending.value = true
  try {
    const latest = await configApi.list(repoId)
    list.value = latest
    loaded.value = {}
    tooLarge.value = []
    draft.value = emptyDraft(latest.baseSha)
    if (reopenJobId) await reopen(reopenJobId, latest)
    loadFailed.value = false
    unreachable.value = null
  }
  catch (err: unknown) {
    loadFailed.value = true
    unreachable.value = err instanceof ApiError && err.code === 409 ? extractApiError(err) : null
    if (unreachable.value === null) toast.error(extractApiError(err))
  }
  finally {
    pending.value = false
  }
}

onMounted(() => {
  void load()
  void options.load().catch(() => undefined)
})

// D474: the draft lives only here, so leaving with unsaved edits asks first.
onBeforeRouteLeave(() => {
  if (submitted.value || edits.value.length === 0) return true
  return window.confirm(t('fleet.config.page.leaveConfirm'))
})

async function select(path: string): Promise<void> {
  selected.value = path
  await loadContent(path)
}

function onEdit(content: string): void {
  const path = selected.value
  if (!path || !canWork.value) return
  const base = loaded.value[path]
  draft.value = base ? editFile(draft.value, base, content) : createFile(draft.value, path, content)
}

function onCreate(path: string): void {
  draft.value = createFile(draft.value, path, '')
  newFileDialog.value = false
  selected.value = path
}

function onDelete(): void {
  const path = selected.value
  if (!path) return
  const base = loaded.value[path]
  draft.value = base ? deleteFile(draft.value, base) : discardFile(draft.value, path)
}

/** A 409 is the one-active-config-job rule (D465) when a job is active; otherwise it is the API's own message. */
async function showConflict(err: unknown): Promise<void> {
  if (err instanceof ApiError && err.code === 409) {
    activeJob.value = await configApi.activeConfigJob(repoId).catch(() => null)
    if (activeJob.value) return
  }
  toast.error(extractApiError(err))
}

async function submitJob(run: () => Promise<DispatchResultDto>): Promise<void> {
  busy.value = true
  activeJob.value = null
  try {
    const result = await run()
    submitted.value = true
    prDialog.value = false
    await navigateTo(`/${slug}/fleet/jobs/${result.job.id}`)
  }
  catch (err: unknown) {
    await showConflict(err)
  }
  finally {
    busy.value = false
  }
}

const save = (body: { prTitle: string; prBody: string }): Promise<void> =>
  submitJob(() => configApi.submitEdit(repoId, { baseSha: draft.value.baseSha, edits: edits.value, ...body }))

const checkDrift = (): Promise<void> => submitJob(() => configApi.submitDrift(repoId))

const problemText = (p: { path: string | null; code: string }): string =>
  (p.path ? `${p.path}: ` : '') + t(`fleet.config.problem.${p.code}`)
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      :title="t('fleet.config.page.title')"
      :subtitle="list ? t('fleet.config.page.subtitle', { repo: options.repoName(repoId), branch: list.defaultBranch, sha: list.baseSha.slice(0, 12) }) : options.repoName(repoId)"
    >
      <template #actions>
        <Button v-if="canWork && list" variant="outline" :disabled="busy" data-testid="config-drift" @click="checkDrift()">
          {{ t('fleet.config.page.checkDrift') }}
        </Button>
        <Button v-if="canWork && list" :disabled="!canSave" data-testid="config-save" @click="prDialog = true">
          {{ t('fleet.config.page.save', { count: edits.length }) }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="!canWork" class="rounded-md border border-border p-3 text-sm text-muted-foreground" data-testid="config-readonly-notice">
      {{ t('fleet.config.page.readOnly') }}
    </p>

    <div v-if="activeJob" class="rounded-md border border-border p-4 text-sm" data-testid="config-active-job">
      {{ t('fleet.config.page.activeJob') }}
      <NuxtLink :to="`/${slug}/fleet/jobs/${activeJob.id}`" class="font-medium text-primary underline-offset-4 hover:underline" data-testid="config-active-job-link">
        {{ t('fleet.config.page.openActiveJob') }}
      </NuxtLink>
    </div>

    <LoadingState v-if="pending" />
    <p v-else-if="unreachable" class="rounded-md border border-destructive p-4 text-sm" data-testid="config-unreachable">
      {{ t('fleet.config.page.unreachable', { message: unreachable }) }}
    </p>
    <ErrorState v-else-if="loadFailed || !list" @retry="load()" />
    <template v-else>
      <ul v-if="problems.length > 0" class="space-y-1 text-sm text-status-rejected" role="alert">
        <li v-for="p in problems" :key="`${p.path ?? ''}:${p.code}`" data-testid="config-problem">{{ problemText(p) }}</li>
      </ul>

      <div class="grid grid-cols-1 gap-6 md:grid-cols-[18rem_1fr]">
        <aside class="space-y-3">
          <Button v-if="canWork" variant="outline" size="sm" class="w-full" data-testid="config-new-file" @click="newFileDialog = true">
            {{ t('fleet.config.page.newFile') }}
          </Button>
          <EmptyState v-if="groups.length === 0" :message="t('fleet.config.page.noFiles')" />
          <NaxFileTree v-else :groups="groups" :selected="selected" @select="select($event)" />
        </aside>

        <section class="min-w-0 space-y-3">
          <p v-if="!selected" class="text-sm text-muted-foreground">{{ t('fleet.config.page.pickFile') }}</p>
          <template v-else>
            <div class="flex items-center gap-2">
              <span class="truncate font-mono text-sm">{{ selected }}</span>
              <Button
                v-if="canWork && selectedContent !== null"
                variant="ghost"
                size="sm"
                class="ml-auto"
                data-testid="config-delete-file"
                @click="onDelete()"
              >
                {{ t('fleet.config.page.deleteFile') }}
              </Button>
            </div>
            <p v-if="selectedDraft && selectedDraft.content === null" class="text-sm text-muted-foreground">{{ t('fleet.config.page.deletedNotice') }}</p>
            <NaxFileEditor
              v-else-if="selectedContent !== null || selectedTooLarge"
              :path="selected"
              :model-value="selectedContent ?? ''"
              :readonly="!canWork"
              :too-large="selectedTooLarge"
              @update:model-value="onEdit($event)"
            />
            <LoadingState v-else />
          </template>
        </section>
      </div>

      <NaxChangesPanel
        v-if="Object.keys(draft.files).length > 0"
        :draft="draft"
        :readonly="!canWork"
        @discard="draft = discardFile(draft, $event)"
        @discard-all="draft = discardAll(draft)"
        @resolve="draft = resolveConflict(draft, $event)"
      />
    </template>

    <ConfigPrDialog :open="prDialog" mode="edit" :busy="busy" @update:open="prDialog = $event" @submit="save($event)" />
    <NewNaxFileDialog :open="newFileDialog" :targets="targets" :existing="existingPaths" @update:open="newFileDialog = $event" @create="onCreate($event)" />
  </div>
</template>
