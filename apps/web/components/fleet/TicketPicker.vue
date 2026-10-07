<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { apiPath } from '~/lib/api-path'
import { removeToken } from '~/lib/fleet-dispatch'
import { addTicketRef, isLinkableTicket, matchTicketOptions, MAX_DISPATCH_TICKETS, normalizeTicketRef, type TicketOption } from '~/lib/fleet-ticket-links'
import type { FleetPage } from '~/lib/fleet-types'

/** Dispatch tickets (C9 §4): picked from the newest open tickets or typed as KEY-N; the server validates (D450). */
const props = defineProps<{ slug: string; modelValue: string[]; testId: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useI18n()
const { $api } = useApi()

/** P1: one page of the newest tickets; older open tickets are typed by ref. */
const OPTION_PAGE_SIZE = '100'
const options = ref<TicketOption[]>([])
const query = ref('')

onMounted(async () => {
  try {
    const page = await $api.get<FleetPage<TicketOption>>(apiPath`/projects/${props.slug}/tickets`, { query: { size: OPTION_PAGE_SIZE } })
    options.value = (page.records ?? [])
      .filter(o => isLinkableTicket(o.status))
      .map(o => ({ ref: o.ref, title: o.title, status: o.status }))
  }
  catch {
    // Suggestions are a convenience: refs can still be typed.
  }
})

const full = computed(() => props.modelValue.length >= MAX_DISPATCH_TICKETS)
const matches = computed(() => matchTicketOptions(options.value, props.modelValue, query.value))
const titleOf = (ticketRef: string): string | null => options.value.find(o => o.ref === ticketRef)?.title ?? null

function add(value: string): void {
  emit('update:modelValue', addTicketRef(props.modelValue, value))
  query.value = ''
}

/** Enter: the typed ref exactly when it is one (so WEB-1 never becomes WEB-12), else the first match. */
function addFromQuery(): void {
  const choice = normalizeTicketRef(query.value) ?? matches.value[0]?.ref
  if (choice) add(choice)
}

function remove(ticketRef: string): void {
  emit('update:modelValue', removeToken(props.modelValue, ticketRef))
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-2">
      <Badge v-for="item in modelValue" :key="item" variant="secondary" class="max-w-full gap-1" :data-testid="`${testId}-item`" :data-ref="item">
        <span class="font-mono">{{ item }}</span>
        <span v-if="titleOf(item)" class="max-w-[16rem] truncate text-muted-foreground">{{ titleOf(item) }}</span>
        <Button type="button" variant="ghost" size="icon" class="h-4 w-4" :aria-label="t('fleet.dispatch.remove', { item })" @click="remove(item)">
          <X class="h-3 w-3" />
        </Button>
      </Badge>
    </div>
    <Input
      v-model="query"
      :disabled="full"
      :placeholder="t('fleet.dispatch.ticketsPlaceholder')"
      :aria-label="t('fleet.dispatch.tickets')"
      :data-testid="`${testId}-input`"
      @keydown.enter.prevent="addFromQuery()"
    />
    <p v-if="full" class="text-xs text-muted-foreground" :data-testid="`${testId}-full`">{{ t('fleet.dispatch.ticketsMax') }}</p>
    <div v-else-if="matches.length > 0" class="flex flex-wrap gap-2">
      <Button
        v-for="option in matches"
        :key="option.ref"
        type="button"
        variant="ghost"
        size="sm"
        class="max-w-full truncate"
        :data-testid="`${testId}-suggestion`"
        :data-ref="option.ref"
        @click="add(option.ref)"
      >
        + {{ option.ref }} {{ option.title }}
      </Button>
    </div>
  </div>
</template>
