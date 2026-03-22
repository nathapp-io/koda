<script setup lang="ts">
import TicketCard from '~/components/TicketCard.vue'

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

const props = defineProps<{ tickets: Ticket[] }>()

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'open-ticket', ticket: Ticket): void
}>()

const COLUMNS: Ticket['status'][] = [
  'CREATED',
  'VERIFIED',
  'IN_PROGRESS',
  'VERIFY_FIX',
  'CLOSED',
  'REJECTED',
]

function ticketsForStatus(status: string): Ticket[] {
  return props.tickets.filter((t) => t.status === status)
}
</script>

<template>
  <div class="overflow-x-auto">
    <div class="flex gap-4 min-w-max p-4">
      <div
        v-for="status in COLUMNS"
        :key="status"
        class="w-64 flex flex-col gap-2"
      >
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold">{{ status }}</span>
            <Badge variant="secondary">{{ ticketsForStatus(status).length }}</Badge>
          </div>
          <button
            v-if="status === 'CREATED'"
            class="text-xs text-primary hover:underline"
            @click="emit('create')"
          >
            New Ticket
          </button>
        </div>
        <TicketCard
          v-for="ticket in ticketsForStatus(status)"
          :key="ticket.id"
          :ticket="ticket"
          @open="emit('open-ticket', ticket)"
        />
      </div>
    </div>
  </div>
</template>
