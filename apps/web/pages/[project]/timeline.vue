<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { humanizeCode } from '~/lib/humanize-code'
import { FILTER_CONTROL_CLASS } from '~/lib/form-control'
import { useLocalDates } from '~/lib/local-dates'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string

const i18n = useI18n()
const { t, te } = i18n
const dates = useLocalDates(i18n)
const memberNames = useProjectMemberNames(slug)
const agentNames = useProjectAgentNames(slug)

function eventTypeLabel(eventType: string): string {
  const key = `home.activity.eventType.${eventType}`
  return te(key) ? t(key) : humanizeCode(eventType)
}

function actorName(actorId: string): string {
  return memberNames.nameOf(actorId) ?? agentNames.nameOf(actorId) ?? actorId
}
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
  void memberNames.load().catch(() => undefined)
  void agentNames.load().catch(() => undefined)
})

function formatDate(dateStr: string) {
  return dates.dateTime(dateStr)
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.timeline')" />

    <FilterBar columns="3">
      <div class="flex flex-col gap-1">
        <label for="timeline-event-type" class="text-xs font-medium text-muted-foreground">{{ t('timeline.filter.eventType') }}</label>
        <select id="timeline-event-type" v-model="eventTypeFilter" :class="FILTER_CONTROL_CLASS" @change="applyAndToast">
          <option v-for="opt in EVENT_TYPES" :key="opt" :value="opt">
            {{ opt ? eventTypeLabel(opt) : t('timeline.filter.all') }}
          </option>
        </select>
      </div>

      <div class="flex flex-col gap-1">
        <label for="timeline-from" class="text-xs font-medium text-muted-foreground">{{ t('timeline.filter.from') }}</label>
        <Input id="timeline-from" v-model="fromFilter" type="date" @change="applyAndToast" />
      </div>

      <div class="flex flex-col gap-1">
        <label for="timeline-to" class="text-xs font-medium text-muted-foreground">{{ t('timeline.filter.to') }}</label>
        <Input id="timeline-to" v-model="toFilter" type="date" @change="applyAndToast" />
      </div>
    </FilterBar>

    <LoadingState v-if="isLoading" />

    <div
      v-else-if="error"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('timeline.error') }}</p>
    </div>

    <div
      v-else-if="events.length === 0"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('timeline.empty') }}</p>
    </div>

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
            <td class="px-4 py-3 font-mono text-xs">{{ eventTypeLabel(event.eventType) }}</td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ actorName(event.actorId) }}</td>
            <td class="px-4 py-3" :title="event.action">{{ humanizeCode(event.action) }}</td>
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
