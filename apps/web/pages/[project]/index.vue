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
  items: Ticket[]
  total: number
  page: number
  limit: number
}

const { data: ticketsData, pending, error, refresh } = useAsyncData(
  `tickets-${slug}`,
  () => $api.get<TicketPage>(`/projects/${slug}/tickets`),
)

const tickets = computed(() => ticketsData.value?.items ?? [])
const showCreateDialog = ref(false)

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
      </template>
    </PageHeader>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <TicketBoard v-else
      :tickets="tickets"
      @open-ticket="handleOpenTicket"
      @create="showCreateDialog = true"
    />

    <CreateTicketDialog
      :open="showCreateDialog"
      :project-slug="slug"
      @update:open="showCreateDialog = $event"
      @created="handleCreated"
    />
  </div>
</template>
