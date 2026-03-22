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

const slug = route.params.project as string

const { $api } = useApi()

const { data: ticketsData, refresh } = useAsyncData(
  `tickets-${slug}`,
  () => $api.get(`/projects/${slug}/tickets`) as Promise<Ticket[]>,
)

const tickets = computed(() => ticketsData.value ?? [])
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
    <TicketBoard
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
