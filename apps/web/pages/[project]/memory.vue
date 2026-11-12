<script setup lang="ts">
import { reactive, ref } from 'vue'
import { Brain } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'
import { useMemory, watchDebouncedMemorySearch } from '~/composables/useMemory'
import { useProjectRef } from '~/composables/useProjectRef'
import { humanizeCode } from '~/lib/humanize-code'
import { memorySubject } from '~/lib/memory-subject'
import { FILTER_CONTROL_CLASS } from '~/lib/form-control'
import type { MemoryItem, RetireOutcome } from '~/composables/useMemory'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t, te } = useI18n()
const toast = useAppToast()
const { permissions } = useProjectPermissions(slug)

const {
  items,
  isLoading,
  error,
  hasMore,
  kindFilter,
  statusFilter,
  textFilter,
  loadMemory,
  applyFilters,
  loadMore,
  retireDecision,
  retireNote,
} = useMemory(slug)
const projectRef = useProjectRef(slug)
const retireTarget = ref<MemoryItem | null>(null)
const retireBusy = ref(false)

const KIND_OPTIONS = ['', 'FACT', 'DECISION', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN', 'NOTE']
const STATUS_OPTIONS = ['', 'active', 'superseded', 'rejected']

async function withToastError(action: () => Promise<unknown>) {
  try {
    await action()
  }
  catch (err) {
    toast.error(extractApiError(err))
  }
}

const loadAndToast = () => withToastError(loadMemory)
const applyAndToast = () => withToastError(applyFilters)
const loadMoreAndToast = () => withToastError(loadMore)
const expandedNotes = reactive(new Set<string>())
watchDebouncedMemorySearch(textFilter, () => {
  void withToastError(applyFilters)
})

function canRetire(item: { kind: string; status: string }) {
  if (item.status !== 'active') return false
  if (item.kind === 'DECISION') return permissions.value.has('memory.decision.retire')
  if (item.kind === 'NOTE') return permissions.value.has('memory.create') || permissions.value.hasOwn('memory.create')
  return false
}

function toggleNote(itemId: string) {
  if (expandedNotes.has(itemId)) expandedNotes.delete(itemId)
  else expandedNotes.add(itemId)
}

/**
 * The dialog belongs to one row at a time. While a retire request is in flight the busy row's
 * request is the only one that can settle, so another row cannot take the dialog over: otherwise
 * the in-flight request's settle would clear the target and close the other row's dialog too.
 */
function openRetire(item: MemoryItem) {
  if (retireBusy.value) return
  retireTarget.value = item
}

/** Closes the dialog only if it still belongs to the row whose request just settled. */
function closeRetire(item: MemoryItem) {
  if (retireTarget.value?.id === item.id) retireTarget.value = null
}

async function confirmRetire(reason: string) {
  const item = retireTarget.value
  if (!item || retireBusy.value) return
  retireBusy.value = true
  try {
    let outcome: RetireOutcome
    if (item.kind === 'DECISION') outcome = await retireDecision(item.id, reason)
    else if (item.kind === 'NOTE') {
      const projectId = await projectRef.load()
      if (!projectId) throw new Error('Project could not be resolved')
      outcome = await retireNote(item.id, projectId, reason)
    }
    else return

    closeRetire(item)
    if (outcome.kind === 'pending') {
      toast.success(t('memory.retire.pending'))
    }
    else {
      toast.success(t('memory.retire.done'))
      await withToastError(applyFilters)
    }
  }
  catch (err) {
    toast.error(extractApiError(err))
  }
  finally {
    retireBusy.value = false
  }
}

onMounted(() => {
  loadAndToast()
})

function formatConfidence(value: number) {
  return value.toFixed(2)
}

function kindLabel(kind: string) {
  const key = `memory.kinds.${kind}`
  return te(key) ? t(key) : humanizeCode(kind)
}

function objectLabel(item: MemoryItem) {
  if (item.predicate !== 'status') return item.object
  const key = `tickets.status.${item.object}`
  return te(key) ? t(key) : item.object
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.memory')">
      <template #icon>
        <Brain class="h-5 w-5" />
      </template>
    </PageHeader>

    <FilterBar columns="3">
      <div class="flex flex-col gap-1">
        <label for="memory-kind-filter" class="text-xs font-medium text-muted-foreground">{{ t('memory.filter.kind') }}</label>
        <select id="memory-kind-filter" v-model="kindFilter" :class="FILTER_CONTROL_CLASS" @change="applyAndToast">
          <option v-for="opt in KIND_OPTIONS" :key="opt" :value="opt">
            {{ opt ? kindLabel(opt) : t('memory.filter.all') }}
          </option>
        </select>
      </div>

      <div class="flex flex-col gap-1">
        <label for="memory-status-filter" class="text-xs font-medium text-muted-foreground">{{ t('memory.filter.status') }}</label>
        <select id="memory-status-filter" v-model="statusFilter" :class="FILTER_CONTROL_CLASS" @change="applyAndToast">
          <option v-for="opt in STATUS_OPTIONS" :key="opt" :value="opt">
            {{ opt || t('memory.filter.all') }}
          </option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('memory.filter.search') }}</label>
        <input v-model="textFilter" type="search" maxlength="100" :placeholder="t('memory.searchPlaceholder')" :class="FILTER_CONTROL_CLASS">
      </div>
    </FilterBar>

    <LoadingState v-if="isLoading" />

    <div
      v-else-if="error"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('memory.error') }}</p>
    </div>

    <div
      v-else-if="items.length === 0"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('memory.empty') }}</p>
    </div>

    <div v-else class="overflow-hidden rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="bg-muted/50">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('memory.columns.subject') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('memory.columns.predicate') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('memory.columns.object') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('memory.columns.kind') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('memory.columns.confidence') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('memory.columns.status') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground" />
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="item in items" :key="item.id" class="hover:bg-muted/30">
            <td class="px-4 py-3 font-mono text-xs">
              <template v-for="subject in [memorySubject(item.subject)]" :key="item.id">
                <span :title="item.subject">
                  <NuxtLink v-if="subject.type === 'ticket'" :to="`/${slug}/tickets/${subject.id}`">
                    {{ t('memory.subject.ticket') }} {{ subject.short }}
                  </NuxtLink>
                  <template v-else-if="subject.type === 'agent'">{{ t('memory.subject.agent') }} {{ subject.short }}</template>
                  <template v-else>{{ item.subject }}</template>
                </span>
              </template>
              <span v-if="item.scope === 'user'" class="ml-2 rounded border border-border px-1.5 py-0.5 text-xs font-sans">{{ t('memory.scope.user') }}</span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ item.predicate }}</td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">
              <template v-if="item.kind === 'NOTE'">
                <p>{{ item.description }}</p>
                <button type="button" class="mt-1 text-link underline" :aria-expanded="expandedNotes.has(item.id)" @click="toggleNote(item.id)">{{ t('memory.expand') }}</button>
                <p v-if="expandedNotes.has(item.id)" class="mt-2 whitespace-pre-wrap">{{ item.object }}</p>
              </template>
              <template v-else>{{ objectLabel(item) }}</template>
            </td>
            <td class="px-4 py-3"><span :title="item.kind" class="rounded border border-border px-1.5 py-0.5 text-xs">{{ kindLabel(item.kind) }}</span></td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ formatConfidence(item.confidence) }}</td>
            <td class="px-4 py-3"><span class="rounded border border-border px-1.5 py-0.5 text-xs">{{ item.status }}</span></td>
            <td class="px-4 py-3">
              <Button v-if="canRetire(item)" variant="outline" size="sm" @click="openRetire(item)">{{ t('memory.retire.action') }}</Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <MemoryRetireDialog
      :open="retireTarget !== null"
      :item-label="retireTarget?.subject ?? ''"
      :busy="retireBusy"
      @update:open="(open) => { if (!open) retireTarget = null }"
      @confirm="confirmRetire"
    />

    <div v-if="hasMore" class="flex justify-center">
      <Button variant="outline" :disabled="isLoading" @click="loadMoreAndToast">
        {{ isLoading ? t('common.loading') : t('memory.loadMore') }}
      </Button>
    </div>
  </div>
</template>
