<script setup lang="ts">
import TicketCard from '~/components/TicketCard.vue'

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

const props = defineProps<{ tickets: Ticket[] }>()

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'open-ticket', ticket: Ticket): void
}>()

const { t } = useI18n()

const COLUMNS: Ticket['status'][] = [
  'CREATED',
  'VERIFIED',
  'IN_PROGRESS',
  'VERIFY_FIX',
  'CLOSED',
  'REJECTED',
]

const STATUS_DOT: Record<Ticket['status'], string> = {
  CREATED: 'bg-status-todo',
  VERIFIED: 'bg-status-todo',
  IN_PROGRESS: 'bg-status-active',
  VERIFY_FIX: 'bg-status-review',
  CLOSED: 'bg-status-done',
  REJECTED: 'bg-status-rejected',
}

function ticketsForStatus(status: string): Ticket[] {
  return props.tickets.filter((t) => t.status === status)
}
</script>

<template>
  <div class="overflow-x-auto">
    <div class="flex gap-3 min-w-max pb-4">
      <div
        v-for="status in COLUMNS"
        :key="status"
        :data-testid="`board-column-${status}`"
        class="w-72 flex flex-col gap-2 rounded-lg bg-muted/50 border border-border/60 p-2.5"
      >
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span :class="['h-2 w-2 rounded-full', STATUS_DOT[status]]" aria-hidden="true" />
            <span class="text-sm font-semibold">{{ t(`tickets.status.${status}`) }}</span>
            <Badge variant="secondary">{{ ticketsForStatus(status).length }}</Badge>
          </div>
          <Button
            v-if="status === 'CREATED'"
            variant="ghost"
            size="sm"
            class="text-xs text-primary hover:underline whitespace-nowrap"
            @click="emit('create')"
          >
            {{ t('tickets.newTicket') }}
          </Button>
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
