<script setup lang="ts">
import TicketCard from '~/components/TicketCard.vue'
import { TICKET_DOT_CLASS, statusDotClass } from '~/lib/ticket-chips'

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
        class="w-72 flex flex-col gap-2 rounded-lg bg-muted/50 border border-border/60 p-3"
      >
        <div :data-testid="`board-column-header-${status}`" class="flex h-8 items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span :class="[TICKET_DOT_CLASS, statusDotClass(status)]" aria-hidden="true" />
            <span class="text-sm font-medium">{{ t(`tickets.status.${status}`) }}</span>
            <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ ticketsForStatus(status).length }}</span>
          </div>
          <Button
            v-if="status === 'CREATED'"
            variant="ghost"
            size="sm"
            class="h-7 text-xs text-link hover:underline whitespace-nowrap"
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
