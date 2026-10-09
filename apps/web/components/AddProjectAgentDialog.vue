<script setup lang="ts">
/**
 * Add an agent to a project's roster.
 *
 * The dialog loads its own candidates: a watcher on `open` calls
 * `loadCandidates`, which fetches `GET /agents` and keeps the unrostered, online
 * agents in a local ref. The picker is reset on every open.
 *
 * The dialog does not own the POST: it emits `added` with the selected slug
 * and lets the page (which owns useProjectAgents) call the API. On a POST
 * failure the page forwards the extracted error message via the `error`
 * prop, and the page keeps the dialog open so the caller can correct the
 * input and retry.
 */
import { ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'

interface RosterEntry { slug: string }
interface AgentChoice {
  id?: string
  slug: string
  name: string
  status: string
}

const props = defineProps<{
  open: boolean
  /** Rostered agent slugs to exclude from the available-agents list. */
  roster: RosterEntry[]
  /** Error message from a failed POST, forwarded by the page. */
  error: string | null
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
const isLoadingCandidates = ref(false)

const rosterSlugs = computed(() => new Set((props.roster ?? []).map((entry) => entry.slug)))

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedSlug.value = ''
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

function onConfirm(): void {
  if (!selectedSlug.value) return
  emit('added', selectedSlug.value)
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

      <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-status-rejected">
        {{ error }}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" @click="onCancel">
          {{ t('common.cancel') }}
        </Button>
        <Button type="button" :disabled="!selectedSlug" @click="onConfirm">
          {{ t('agents.addProjectAgent.confirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
