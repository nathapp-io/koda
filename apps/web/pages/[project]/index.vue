<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface Assignee {
  name: string
  email?: string
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

interface TicketPage {
  records: Ticket[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

const BOARD_PAGE_SIZE = 100

const { data: ticketsData, pending, error, refresh } = useAsyncData(
  `tickets-${slug}`,
  () => $api.get<TicketPage>(`/projects/${slug}/tickets`, { query: { size: BOARD_PAGE_SIZE } }),
)

// Pages after the first, appended by "load more"; cleared whenever page 1 reloads.
const moreTickets = ref<Ticket[]>([])
const lastPage = ref<TicketPage | null>(null)
const loadingMore = ref(false)

watch(ticketsData, () => {
  moreTickets.value = []
  lastPage.value = null
})

const tickets = computed(() => [...(ticketsData.value?.records ?? []), ...moreTickets.value])
const hasNext = computed(() => (lastPage.value ?? ticketsData.value)?.hasNext ?? false)

async function loadMoreTickets() {
  const current = (lastPage.value ?? ticketsData.value)?.current ?? 1
  loadingMore.value = true
  try {
    const next = await $api.get<TicketPage>(`/projects/${slug}/tickets`, {
      query: { current: current + 1, size: BOARD_PAGE_SIZE },
    })
    moreTickets.value = [...moreTickets.value, ...next.records]
    lastPage.value = next
  }
  finally {
    loadingMore.value = false
  }
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
    <TicketBoard v-else
      :tickets="tickets"
      @open-ticket="handleOpenTicket"
      @create="showCreateDialog = true"
    />
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
