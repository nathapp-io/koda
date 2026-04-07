<script setup lang="ts">

interface Assignee {
  name: string
  email?: string
}

interface TicketLink {
  id: string
  url: string
  provider: string
  externalRef: string | null
  prState?: string | null
  prNumber?: number | null
}

interface Ticket {
  id: string
  ref: string
  title: string
  type: 'BUG' | 'ENHANCEMENT'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  assignee?: Assignee | null
  externalVcsUrl?: string | null
  links?: TicketLink[]
}

const props = defineProps<{ ticket: Ticket }>()

const emit = defineEmits<{ (e: 'open'): void }>()

const { t } = useI18n()

function typeBadgeClass(type: string): string {
  if (type === 'BUG') return 'border-red-300 text-red-700'
  if (type === 'ENHANCEMENT') return 'border-blue-300 text-blue-700'
  return ''
}

function priorityVariant(priority: string): string {
  if (priority === 'CRITICAL') return 'destructive'
  if (priority === 'HIGH') return 'outline'
  if (priority === 'MEDIUM') return 'secondary'
  return 'outline'
}

function priorityClass(priority: string): string {
  if (priority === 'HIGH') return 'bg-orange-100 text-orange-800 border-orange-300'
  return ''
}

function assigneeInitials(assignee: Assignee): string {
  return assignee.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function extractIssueNumber(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] || ''
}

const githubPrWithState = computed(() => {
  if (!props.ticket.links) return null
  return props.ticket.links.find(link => link.provider === 'github' && link.prState)
})

function prStateVariant(state: string): string {
  if (state === 'merged') return 'bg-green-500'
  if (state === 'open') return 'bg-blue-500'
  if (state === 'draft') return 'bg-gray-400'
  if (state === 'closed') return 'bg-red-500'
  return 'bg-gray-400'
}
</script>

<template>
  <Card class="cursor-pointer hover:shadow-md transition-shadow" @click="emit('open')">
    <CardContent class="p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="flex-1 min-w-0">
          <span class="font-mono text-xs text-muted-foreground">{{ ticket.ref }}</span>
          <p class="mt-1 text-sm font-medium leading-snug truncate">{{ ticket.title }}</p>
          <div class="mt-2 flex flex-wrap gap-1">
            <Badge
              variant="outline"
              :class="typeBadgeClass(ticket.type)"
            >
              {{ t(`tickets.type.${ticket.type}`) }}
            </Badge>
            <Badge
              :variant="priorityVariant(ticket.priority) as 'destructive' | 'secondary' | 'outline' | 'default'"
              :class="priorityClass(ticket.priority)"
            >
              {{ t(`tickets.priority.${ticket.priority}`) }}
            </Badge>
            <Badge v-if="ticket.externalVcsUrl" variant="outline">
              {{ t('tickets.vcs.github') }} #{{ extractIssueNumber(ticket.externalVcsUrl) }}
            </Badge>
            <Badge v-if="githubPrWithState" variant="outline" class="gap-1">
              <span class="w-2 h-2 rounded-full" :class="prStateVariant(githubPrWithState.prState!)"></span>
              {{ t(`tickets.pr.status.${githubPrWithState.prState}`) }}
            </Badge>
          </div>
        </div>
        <Avatar v-if="ticket.assignee" class="h-7 w-7 shrink-0">
          <AvatarFallback class="text-xs">
            {{ assigneeInitials(ticket.assignee) }}
          </AvatarFallback>
        </Avatar>
      </div>
    </CardContent>
  </Card>
</template>
