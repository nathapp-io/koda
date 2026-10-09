<script setup lang="ts">
/**
 * Add an agent to a project's roster.
 *
 * `loadCandidates` is called by the parent when the dialog opens (or when the
 * parent wants to retry). The dialog keeps the available-agents list in a
 * local ref so the parent can read it through a v-model or by passing the
 * ref back, and so the picker can be reset on every open.
 *
 * The dialog does not own the POST: it emits `add` with the selected slug
 * and lets the page (which owns useProjectAgents) call the API. On a POST
 * failure the dialog stays open and surfaces `extractApiError(err)`, so the
 * caller can decide to retry without re-opening the dialog.
 */
import { ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface RosterEntry { slug: string }
interface AgentChoice {
  id?: string
  slug: string
  name: string
  status: string
}

const props = defineProps<{
  open: boolean
  /** Project slug — used for the page-routed fetch. */
  slug: string
  /** Rostered agent slugs to exclude from the available-agents list. */
  roster: RosterEntry[]
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'added', agentSlug: string): void
}>()

const { t } = useI18n()
const { $api } = useApi()

const availableAgents = ref<AgentChoice[]>([])
const candidatesError = ref<string | null>(null)
const selectedSlug = ref('')
const isAdding = ref(false)
const isLoadingCandidates = ref(false)
const addError = ref<string | null>(null)

const rosterSlugs = computed(() => new Set((props.roster ?? []).map((entry) => entry.slug)))

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedSlug.value = ''
      addError.value = null
      void loadCandidates()
    }
  },
)

async function loadCandidates(): Promise<void> {
  isLoadingCandidates.value = true
  candidatesError.value = null
  try {
    const res = (await $api.get('/agents')) as AgentChoice[]
    const list = Array.isArray(res) ? res : []
    availableAgents.value = list.filter(
      (agent) => agent && typeof agent.slug === 'string' && !rosterSlugs.value.has(agent.slug) && agent.status !== 'OFFLINE',
    )
  } catch (caught) {
    candidatesError.value = extractApiError(caught)
  } finally {
    isLoadingCandidates.value = false
  }
}

defineExpose({ loadCandidates, availableAgents })

async function onConfirm(): Promise<void> {
  if (!selectedSlug.value || isAdding.value) return
  isAdding.value = true
  addError.value = null
  try {
    await $api.post(apiPath`/projects/${props.slug}/agents`, { agentSlug: selectedSlug.value })
    emit('added', selectedSlug.value)
    emit('update:open', false)
  } catch (caught) {
    addError.value = extractApiError(caught)
  } finally {
    isAdding.value = false
  }
}

function onCancel(): void {
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('agents.addProjectAgent.title') }}</DialogTitle>
      </DialogHeader>

      <p class="text-sm text-muted-foreground">
        {{ t('agents.addProjectAgent.description') }}
      </p>

      <div v-if="candidatesError" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-status-rejected">
        {{ candidatesError }}
      </div>

      <div class="space-y-2">
        <label class="text-sm font-medium" for="add-project-agent-select">
          {{ t('agents.addProjectAgent.selectPlaceholder') }}
        </label>
        <Select v-model="selectedSlug" :disabled="isLoadingCandidates || availableAgents.length === 0">
          <SelectTrigger id="add-project-agent-select" class="w-full">
            <SelectValue :placeholder="t('agents.addProjectAgent.selectPlaceholder')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="agent in availableAgents" :key="agent.slug" :value="agent.slug">
              {{ agent.name }} ({{ agent.slug }})
            </SelectItem>
          </SelectContent>
        </Select>
        <p v-if="!isLoadingCandidates && availableAgents.length === 0 && !candidatesError" class="text-sm text-muted-foreground">
          {{ t('agents.addProjectAgent.noCandidates') }}
        </p>
      </div>

      <div v-if="addError" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-status-rejected">
        {{ addError }}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" @click="onCancel">
          {{ t('common.cancel') }}
        </Button>
        <Button type="button" :disabled="!selectedSlug || isAdding" @click="onConfirm">
          {{ isAdding ? t('agents.addProjectAgent.adding') : t('agents.addProjectAgent.confirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
