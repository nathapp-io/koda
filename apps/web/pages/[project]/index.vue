<script setup lang="ts">
const route = useRoute()
const router = useRouter()

const slug = route.params.project as string

const { $api } = useApi()

const { data: tickets, refresh } = await useAsyncData(
  `tickets-${slug}`,
  () => $api.get<Ticket[]>(`/projects/${slug}/tickets`),
)

const showCreateDialog = ref(false)

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

function handleOpenTicket(ticket: Ticket) {
  router.push(`/${slug}/tickets/${ticket.ref}`)
}

function handleCreate() {
  showCreateDialog.value = true
}

async function handleCreated() {
  showCreateDialog.value = false
  await refresh()
}
</script>

<template>
  <div>
    <TicketBoard
      :tickets="tickets ?? []"
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
