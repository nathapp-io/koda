<script setup lang="ts">
import TicketCard from '~/components/TicketCard.vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { TICKET_DOT_CLASS, statusDotClass } from '~/lib/ticket-chips'
import { boardScrollHints } from '~/lib/ticket-board-scroll'

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

const scrollContainer = ref<HTMLDivElement | null>(null)
const scrollHints = ref({ left: false, right: false })

function measure(): void {
  const element = scrollContainer.value
  if (!element) return
  scrollHints.value = boardScrollHints({
    scrollLeft: element.scrollLeft,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  })
}

function scrollBy(left: number): void {
  scrollContainer.value?.scrollBy({ left, behavior: 'smooth' })
}

onMounted(() => {
  measure()
  if (typeof window !== 'undefined') window.addEventListener('resize', measure)
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('resize', measure)
})

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
  <div
    ref="scrollContainer"
    data-testid="board-scroll-container"
    class="relative overflow-x-auto"
    @scroll="measure"
  >
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
    <div v-if="scrollHints.left" data-testid="board-scroll-left" class="pointer-events-none absolute inset-y-0 left-0 flex items-center bg-gradient-to-r from-background to-transparent pl-2">
      <Button
        variant="outline"
        size="icon"
        class="pointer-events-auto"
        :aria-label="t('tickets.board.scrollLeft')"
        @click="scrollBy(-300)"
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
    </div>
    <div v-if="scrollHints.right" data-testid="board-scroll-right" class="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-background to-transparent pr-2">
      <Button
        variant="outline"
        size="icon"
        class="pointer-events-auto"
        :aria-label="t('tickets.board.scrollRight')"
        @click="scrollBy(300)"
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  </div>
</template>
