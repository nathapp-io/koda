<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()

const {
  events,
  isLoading,
  error,
  hasMore,
  eventTypeFilter,
  fromFilter,
  toFilter,
  loadEvents,
  applyFilters,
  loadMore,
} = useTimelineEvents(slug)

const EVENT_TYPES = ['', 'ticket_event', 'agent_event', 'decision_event']

async function withToastError(action: () => Promise<unknown>) {
  try {
    await action()
  }
  catch (err) {
    toast.error(extractApiError(err))
  }
}

const loadAndToast = () => withToastError(loadEvents)
const applyAndToast = () => withToastError(applyFilters)
const loadMoreAndToast = () => withToastError(loadMore)

onMounted(() => {
  loadAndToast()
})

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString()
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.timeline')" />

    <div class="flex flex-wrap items-end gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('timeline.filter.eventType') }}</label>
        <select v-model="eventTypeFilter" class="rounded-md border border-border bg-background px-2 py-1 text-sm" @change="applyAndToast">
          <option v-for="opt in EVENT_TYPES" :key="opt" :value="opt">
            {{ opt || t('timeline.filter.all') }}
          </option>
        </select>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('timeline.filter.from') }}</label>
        <Input v-model="fromFilter" type="date" @change="applyAndToast" />
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('timeline.filter.to') }}</label>
        <Input v-model="toFilter" type="date" @change="applyAndToast" />
      </div>
    </div>

    <LoadingState v-if="isLoading" />

    <div
      v-else-if="events.length === 0"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('timeline.empty') }}</p>
    </div>

    <div v-else-if="error" />

    <div v-else class="overflow-hidden rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="bg-muted/50">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('timeline.columns.eventType') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('timeline.columns.actorId') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('timeline.columns.action') }}</th>
            <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('timeline.columns.created') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="event in events" :key="event.id" class="hover:bg-muted/30">
            <td class="px-4 py-3 font-mono text-xs">{{ event.eventType }}</td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ event.actorId }}</td>
            <td class="px-4 py-3">{{ event.action }}</td>
            <td class="whitespace-nowrap px-4 py-3 text-muted-foreground">{{ formatDate(event.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="hasMore" class="flex justify-center">
      <Button variant="outline" :disabled="isLoading" @click="loadMoreAndToast">
        {{ isLoading ? t('common.loading') : t('timeline.loadMore') }}
      </Button>
    </div>
  </div>
</template>
