<script setup lang="ts">
import { reactive } from 'vue'
import { Brain } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'
import { watchDebouncedMemorySearch } from '~/composables/useMemory'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()

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
} = useMemory(slug)

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

function toggleNote(itemId: string) {
  if (expandedNotes.has(itemId)) expandedNotes.delete(itemId)
  else expandedNotes.add(itemId)
}

onMounted(() => {
  loadAndToast()
})

function formatConfidence(value: number) {
  return value.toFixed(2)
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
        <label class="text-xs font-medium text-muted-foreground">{{ t('memory.filter.kind') }}</label>
        <select v-model="kindFilter" class="rounded-md border border-border bg-background px-2 py-1 text-sm" @change="applyAndToast">
          <option v-for="opt in KIND_OPTIONS" :key="opt" :value="opt">
            {{ opt || t('memory.filter.all') }}
          </option>
        </select>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('memory.filter.status') }}</label>
        <select v-model="statusFilter" class="rounded-md border border-border bg-background px-2 py-1 text-sm" @change="applyAndToast">
          <option v-for="opt in STATUS_OPTIONS" :key="opt" :value="opt">
            {{ opt || t('memory.filter.all') }}
          </option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('memory.filter.search') }}</label>
        <input v-model="textFilter" type="search" maxlength="100" :placeholder="t('memory.searchPlaceholder')" class="rounded-md border border-border bg-background px-2 py-1 text-sm">
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
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="item in items" :key="item.id" class="hover:bg-muted/30">
            <td class="px-4 py-3 font-mono text-xs">
              {{ item.subject }}
              <span v-if="item.scope === 'user'" class="ml-2 rounded border border-border px-1.5 py-0.5 text-xs font-sans">{{ t('memory.scope.user') }}</span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ item.predicate }}</td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">
              <template v-if="item.kind === 'NOTE'">
                <p>{{ item.description }}</p>
                <button type="button" class="mt-1 text-primary underline" :aria-expanded="expandedNotes.has(item.id)" @click="toggleNote(item.id)">{{ t('memory.expand') }}</button>
                <p v-if="expandedNotes.has(item.id)" class="mt-2 whitespace-pre-wrap">{{ item.object }}</p>
              </template>
              <template v-else>{{ item.object }}</template>
            </td>
            <td class="px-4 py-3"><span class="rounded border border-border px-1.5 py-0.5 text-xs">{{ item.kind }}</span></td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ formatConfidence(item.confidence) }}</td>
            <td class="px-4 py-3"><span class="rounded border border-border px-1.5 py-0.5 text-xs">{{ item.status }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="hasMore" class="flex justify-center">
      <Button variant="outline" :disabled="isLoading" @click="loadMoreAndToast">
        {{ isLoading ? t('common.loading') : t('memory.loadMore') }}
      </Button>
    </div>
  </div>
</template>
