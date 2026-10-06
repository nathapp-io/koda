<script setup lang="ts">
import { computed, ref as vueRef, onBeforeUnmount } from 'vue'
import { Check, Copy } from 'lucide-vue-next'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS, STATUS_DOT, PRIORITY_DOT, typeChipClass } from '~/lib/ticket-chips'

type TicketType = 'BUG' | 'ENHANCEMENT' | 'TASK' | 'QUESTION'
type TicketPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
type TicketStatus = 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'

interface Ticket {
  id: string
  ref: string
  title: string
  type: TicketType
  priority: TicketPriority
  status: TicketStatus
  createdAt: string
  [key: string]: unknown
}

const props = defineProps<{
  ticket: Ticket
  editing: boolean
  editTitle: string
  editPriority: TicketPriority
}>()

const emit = defineEmits<{
  (e: 'update:editTitle', value: string): void
  (e: 'update:editPriority', value: TicketPriority): void
  (e: 'start-edit'): void
  (e: 'cancel-edit'): void
  (e: 'save'): void
}>()

const { t, locale } = useI18n()

const chipClass = TICKET_CHIP_CLASS
const dotClass = TICKET_DOT_CLASS

const typeClass = computed(() => typeChipClass(props.ticket.type))

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const copied = vueRef(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyRef() {
  try {
    await navigator.clipboard.writeText(props.ticket.ref)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1500)
  } catch {
    copied.value = false
  }
}

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
  <header class="min-w-0">
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <span class="font-mono">{{ ticket.ref }}</span>
      <Button
        variant="ghost"
        size="icon"
        class="h-6 w-6"
        :aria-label="t('tickets.detail.copyRef')"
        @click="copyRef"
      >
        <Check v-if="copied" class="h-3.5 w-3.5 text-status-done" aria-hidden="true" />
        <Copy v-else class="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <span aria-hidden="true">·</span>
      <span>{{ t('tickets.detail.opened', { date: formatDate(ticket.createdAt) }) }}</span>
    </div>

    <div class="mt-1 flex items-start justify-between gap-3">
      <h1 v-if="!editing" class="min-w-0 text-2xl font-semibold leading-tight tracking-tight">
        {{ ticket.title }}
      </h1>
      <Input
        v-else
        :model-value="editTitle"
        class="text-2xl font-semibold"
        :placeholder="t('tickets.form.titlePlaceholder')"
        :aria-label="t('tickets.form.titleLabel')"
        @update:model-value="emit('update:editTitle', $event)"
      />
      <div class="flex shrink-0 gap-2">
        <Button v-if="!editing" variant="outline" size="sm" @click="emit('start-edit')">
          {{ t('common.edit') }}
        </Button>
        <template v-else>
          <Button variant="outline" size="sm" @click="emit('cancel-edit')">
            {{ t('common.cancel') }}
          </Button>
          <Button size="sm" @click="emit('save')">
            {{ t('common.save') }}
          </Button>
        </template>
      </div>
    </div>

    <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
      <span :class="chipClass"><span :class="[dotClass, STATUS_DOT[ticket.status]]" aria-hidden="true" />{{ t(`tickets.status.${ticket.status}`) }}</span>
      <Select
        v-if="editing"
        :model-value="editPriority"
        @update:model-value="emit('update:editPriority', $event as TicketPriority)"
      >
        <SelectTrigger class="w-[140px]" :aria-label="t('tickets.form.priority')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="CRITICAL">{{ t('tickets.priority.CRITICAL') }}</SelectItem>
          <SelectItem value="HIGH">{{ t('tickets.priority.HIGH') }}</SelectItem>
          <SelectItem value="MEDIUM">{{ t('tickets.priority.MEDIUM') }}</SelectItem>
          <SelectItem value="LOW">{{ t('tickets.priority.LOW') }}</SelectItem>
        </SelectContent>
      </Select>
      <span v-else :class="chipClass"><span :class="[dotClass, PRIORITY_DOT[ticket.priority]]" aria-hidden="true" />{{ t(`tickets.priority.${ticket.priority}`) }}</span>
      <span :class="typeClass">{{ t(`tickets.type.${ticket.type}`) }}</span>
    </div>
  </header>
</template>
