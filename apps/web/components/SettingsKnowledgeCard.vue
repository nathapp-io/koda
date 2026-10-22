<script setup lang="ts">
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface KnowledgeRepoState {
  repoId: string
  owner: string
  name: string
  status: string
  indexedSha: string | null
  fileCount: number
  chunkCount: number
  unembeddedCount: number
  skippedCount: number
  lastError: string | null
  finishedAt: string | null
}

interface KnowledgeState {
  enabled: boolean
  repos: KnowledgeRepoState[]
  patterns: string[]
  customPatterns: boolean
  defaultPatterns: string[]
}

const props = defineProps<{ slug: string }>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

// Permissions P1 US-007: editing the document patterns needs `fleet.knowledge.patterns.update` and
// re-indexing a repository needs `fleet.knowledge.repo.reindex`, both in this project. A pending or
// failed fetch leaves the keys absent, so the editor is read-only and no button renders.
const { permissions } = useProjectPermissions(props.slug)
const canEditPatterns = computed(() => permissions.value.has('fleet.knowledge.patterns.update'))
const canReindex = computed(() => permissions.value.has('fleet.knowledge.repo.reindex'))

/** The API's pattern limits (US-002); the messages are i18n keys, resolved where they are shown. */
const MAX_PATTERNS = 50
const patternsSchema = z.object({
  patterns: z
    .array(z.string().endsWith('.md', { message: 'knowledge.patterns.errorMarkdown' }))
    .min(1, { message: 'knowledge.patterns.errorCount' })
    .max(MAX_PATTERNS, { message: 'knowledge.patterns.errorCount' }),
})

const state = ref<KnowledgeState | null>(null)
const loading = ref(true)
const failed = ref(false)
const patternsText = ref('')
const patternsError = ref<string | null>(null)
const saving = ref(false)
const reindexing = ref<string | null>(null)

async function load(): Promise<void> {
  try {
    const next = await $api.get(apiPath`/projects/${props.slug}/knowledge/repos`) as KnowledgeState
    state.value = next
    patternsText.value = next.patterns.join('\n')
    failed.value = false
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

async function retry(): Promise<void> {
  loading.value = true
  await load()
}

onMounted(load)

async function reindex(repoId: string): Promise<void> {
  // The button only renders with the key; a stray call must not send a request the API will refuse.
  if (!canReindex.value) return
  reindexing.value = repoId
  try {
    await $api.post(apiPath`/projects/${props.slug}/knowledge/repos/${repoId}/reindex`)
    toast.success(t('knowledge.reindex.queued'))
    await load()
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    reindexing.value = null
  }
}

async function putPatterns(patterns: string[] | null, successKey: string): Promise<void> {
  saving.value = true
  try {
    await $api.put(apiPath`/projects/${props.slug}/knowledge/patterns`, { patterns })
    toast.success(t(successKey))
    await load()
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    saving.value = false
  }
}

async function savePatterns(): Promise<void> {
  // The save button only renders with the key; a stray form submit must not send the PUT.
  if (!canEditPatterns.value) return
  const lines = patternsText.value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const parsed = patternsSchema.safeParse({ patterns: lines })
  if (!parsed.success) {
    patternsError.value = parsed.error.issues[0].message
    return
  }
  patternsError.value = null
  await putPatterns(parsed.data.patterns, 'knowledge.patterns.saved')
}

async function resetPatterns(): Promise<void> {
  if (!canEditPatterns.value) return
  patternsError.value = null
  await putPatterns(null, 'knowledge.patterns.reset')
}

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : '')
</script>

<template>
  <div class="space-y-6">
    <LoadingState v-if="loading" />
    <ErrorState v-else-if="failed || !state" @retry="retry" />

    <template v-else>
      <p
        v-if="!state.enabled"
        data-testid="knowledge-disabled"
        class="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground"
      >
        {{ t('knowledge.disabled') }}
      </p>

      <div class="space-y-3">
        <h3 class="text-sm font-medium">{{ t('knowledge.repos.title') }}</h3>
        <p v-if="state.repos.length === 0" class="text-sm text-muted-foreground">{{ t('knowledge.repos.empty') }}</p>
        <div
          v-for="repo in state.repos"
          :key="repo.repoId"
          :data-testid="`knowledge-repo-${repo.repoId}`"
          class="rounded-md border border-border p-4 space-y-2"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="font-medium">{{ repo.owner }}/{{ repo.name }}</span>
              <Badge variant="outline">{{ repo.status }}</Badge>
              <code v-if="repo.indexedSha" class="text-xs text-muted-foreground">{{ shortSha(repo.indexedSha) }}</code>
            </div>
            <Button
              v-if="canReindex && state.enabled"
              type="button"
              variant="outline"
              size="sm"
              :data-testid="`knowledge-reindex-${repo.repoId}`"
              :disabled="reindexing === repo.repoId"
              @click="reindex(repo.repoId)"
            >
              {{ t('knowledge.reindex.action') }}
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ t('knowledge.repos.files') }}: {{ repo.fileCount }} ·
            {{ t('knowledge.repos.chunks') }}: {{ repo.chunkCount }} ·
            {{ t('knowledge.repos.unembedded') }}: {{ repo.unembeddedCount }} ·
            {{ t('knowledge.repos.skipped') }}: {{ repo.skippedCount }}
          </p>
          <p v-if="repo.finishedAt" class="text-xs text-muted-foreground">
            {{ t('knowledge.repos.finishedAt') }}: {{ repo.finishedAt }}
          </p>
          <p v-if="repo.lastError" class="text-xs text-status-rejected">
            {{ t('knowledge.repos.lastError') }}: {{ repo.lastError }}
          </p>
        </div>
      </div>

      <form class="space-y-2" @submit.prevent="savePatterns">
        <FormLabel>{{ t('knowledge.patterns.title') }}</FormLabel>
        <p class="text-xs text-muted-foreground">
          {{ t(state.customPatterns ? 'knowledge.patterns.custom' : 'knowledge.patterns.default') }}
          {{ t('knowledge.patterns.hint') }}
        </p>
        <Textarea
          v-model="patternsText"
          data-testid="knowledge-patterns"
          :readonly="!canEditPatterns"
          rows="6"
        />
        <p v-if="patternsError" data-testid="knowledge-patterns-error" class="text-xs text-status-rejected">
          {{ t(patternsError) }}
        </p>
        <div v-if="canEditPatterns" class="flex flex-wrap gap-3">
          <Button type="submit" data-testid="knowledge-patterns-save" :disabled="saving">
            {{ saving ? t('common.loading') : t('knowledge.patterns.save') }}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="knowledge-patterns-reset"
            :disabled="saving"
            @click="resetPatterns"
          >
            {{ t('knowledge.patterns.resetAction') }}
          </Button>
        </div>
      </form>
    </template>
  </div>
</template>
