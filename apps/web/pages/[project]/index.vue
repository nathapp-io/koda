<script setup lang="ts">
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

function handleCreate() {
  showCreateDialog.value = true
}

function handleCreated() {
  showCreateDialog.value = false
  refresh()
}
</script>

<template>
  <div>
    <div v-if="pending" class="text-center py-12 text-muted-foreground">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="text-center py-12">
      <p class="text-destructive text-sm">{{ t('common.loadFailed') }}</p>
      <Button @click="refresh()">{{ t('common.retry') }}</Button>
    </div>
    <TicketBoard v-else
      :tickets="tickets"
      @open-ticket="handleOpenTicket"
      @create="handleCreate"
    />
    <CreateTicketDialog
      :open="showCreateDialog"
      :project-slug="slug"
      @update:open="showCreateDialog = $event"
      @created="handleCreated"
    />
  </div>
</template>
