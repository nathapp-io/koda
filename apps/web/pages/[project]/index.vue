<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { useTicketBoardPages, type TicketPage } from '~/composables/useTicketBoardPages'

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
const toast = useAppToast()

const BOARD_PAGE_SIZE = 100

const { data: ticketsData, pending, error, refresh } = useAsyncData(
  `tickets-${slug}`,
  () => $api.get<TicketPage<Ticket>>(`/projects/${slug}/tickets`, { query: { size: BOARD_PAGE_SIZE } }),
)

const { tickets, hasNext, loadingMore, loadMoreTickets } = useTicketBoardPages(
  ticketsData,
  current => $api.get<TicketPage<Ticket>>(`/projects/${slug}/tickets`, {
    query: { current, size: BOARD_PAGE_SIZE },
  }),
  err => toast.error(extractApiError(err)),
)

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
