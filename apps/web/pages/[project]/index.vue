<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'
import { useTicketBoardPages, type TicketPage } from '~/composables/useTicketBoardPages'
import { createDebouncer } from '~/lib/debounce'

definePageMeta({ layout: 'default' })

interface Assignee {
  kind: 'user' | 'agent'
  id: string
  name: string
}

interface Ticket {
  id: string
  ref: string
  title: string
  type: 'BUG' | 'ENHANCEMENT'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
  assignee?: Assignee | null
}

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const slug = route.params.project as string

const { $api } = useApi()
const toast = useAppToast()

const BOARD_PAGE_SIZE = 100

const { data: ticketsData, pending, error, refresh } = useAsyncData(
  `tickets-${slug}`,
  () => $api.get<TicketPage<Ticket>>(apiPath`/projects/${slug}/tickets`, { query: { size: BOARD_PAGE_SIZE } }),
)

const { tickets, hasNext, loadingMore, loadMoreTickets, reloadLoaded } = useTicketBoardPages(
  ticketsData,
  current => $api.get<TicketPage<Ticket>>(apiPath`/projects/${slug}/tickets`, {
    query: { current, size: BOARD_PAGE_SIZE },
  }),
  err => toast.error(extractApiError(err)),
)

// Track 1 Slice 5: live updates. Comments do not change the board.
const LIVE_RELOAD_DEBOUNCE_MS = 300
const liveReload = createDebouncer(() => { void reloadLoaded() }, LIVE_RELOAD_DEBOUNCE_MS)
onBeforeUnmount(() => liveReload.cancel())

useProjectEvents(slug, {
  onEvent: (event) => {
    if (event.action !== 'commented') liveReload.trigger()
  },
  onResync: () => liveReload.trigger(),
})

const search = ref('')
const priorityFilter = ref<Ticket['priority'] | null>(null)
const PRIORITIES: Ticket['priority'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

const filteredTickets = computed(() => {
  const q = search.value.trim().toLowerCase()
  return tickets.value.filter((tk) =>
    (!priorityFilter.value || tk.priority === priorityFilter.value)
    && (!q || `${tk.ref} ${tk.title}`.toLowerCase().includes(q)))
})
const isFiltering = computed(() => search.value.trim() !== '' || priorityFilter.value !== null)
function clearFilters() {
  search.value = ''
  priorityFilter.value = null
}

const showCreateDialog = ref(false)
const showImportDialog = ref(false)

function handleOpenTicket(ticket: Ticket) {
  router.push(`/${slug}/tickets/${ticket.ref}`)
}

function handleCreated() {
  showCreateDialog.value = false
  refresh()
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="slug">
      <template #actions>
        <Button @click="showCreateDialog = true">
          {{ t('tickets.newTicket') }}
        </Button>
        <Button @click="showImportDialog = true">
          {{ t('vcs.importIssue.button') }}
        </Button>
      </template>
    </PageHeader>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <template v-else>
      <div class="flex flex-wrap items-center gap-2" role="search">
        <label class="sr-only" for="board-search">{{ t('tickets.filter.search') }}</label>
        <input
          id="board-search"
          v-model="search"
          type="search"
          :placeholder="t('tickets.filter.search')"
          class="h-9 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground sm:w-64"
        >
        <div class="flex flex-wrap gap-1" role="group" :aria-label="t('tickets.filter.priority')">
          <button
            v-for="p in PRIORITIES"
            :key="p"
            type="button"
            :aria-pressed="priorityFilter === p"
            :class="[
              'h-9 cursor-pointer rounded-md border px-3 text-xs font-medium transition-colors',
              priorityFilter === p ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:text-foreground',
            ]"
            @click="priorityFilter = priorityFilter === p ? null : p"
          >
            {{ t(`tickets.priority.${p}`) }}
          </button>
        </div>
        <Button v-if="isFiltering" variant="ghost" size="sm" @click="clearFilters">{{ t('tickets.filter.clear') }}</Button>
        <p v-if="isFiltering" class="text-xs text-muted-foreground" aria-live="polite">
          {{ t('tickets.filter.showing', { n: filteredTickets.length, total: tickets.length }) }}
        </p>
      </div>
    <TicketBoard
      :tickets="filteredTickets"
      @open-ticket="handleOpenTicket"
      @create="showCreateDialog = true"
    />
    </template>
    <div v-if="hasNext" class="flex justify-center">
      <Button variant="outline" :disabled="loadingMore" @click="loadMoreTickets">
        {{ loadingMore ? t('common.loading') : t('tickets.loadMore') }}
      </Button>
    </div>

    <CreateTicketDialog
      :open="showCreateDialog"
      :project-slug="slug"
      @update:open="showCreateDialog = $event"
      @created="handleCreated"
    />

    <ImportIssueDialog
      :open="showImportDialog"
      :project-slug="slug"
      @update:open="showImportDialog = $event"
    />
  </div>
</template>
