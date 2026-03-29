<script setup lang="ts">
definePageMeta({ layout: 'default' })

import { toast } from 'vue-sonner'

interface Assignee {
  id: string
  name: string
  email?: string
}

interface Ticket {
  id: string
  ref: string
  title: string
  description?: string | null
  type: 'BUG' | 'ENHANCEMENT'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
  assignee?: Assignee | null
  createdAt: string
  gitRefFile?: string | null
  gitRefLine?: number | null
  gitRefUrl?: string | null
  [key: string]: unknown
}

const route = useRoute()
const { t, locale } = useI18n()

const slug = route.params.project as string
const ref = route.params.ref as string

const { $api } = useApi()

const { data: ticketData, pending, error, refresh } = useAsyncData(
  `ticket-${slug}-${ref}`,
  () => $api.get(`/projects/${slug}/tickets/${ref}`) as Promise<Ticket>,
)

const ticket = computed(() => ticketData.value ?? null)

function statusClass(status: string) {
  switch (status) {
    case 'VERIFIED': return 'bg-blue-100 text-blue-800'
    case 'IN_PROGRESS': return 'bg-yellow-100 text-yellow-800'
    case 'VERIFY_FIX': return 'bg-purple-100 text-purple-800'
    case 'CLOSED': return 'bg-green-100 text-green-800'
    case 'REJECTED': return ''
    default: return ''
  }
}

function priorityVariant(priority: string): 'destructive' | 'secondary' | 'outline' | 'default' {
  switch (priority) {
    case 'CRITICAL': return 'destructive'
    case 'MEDIUM': return 'secondary'
    case 'LOW': return 'outline'
    default: return 'default'
  }
}

function priorityClass(priority: string) {
  if (priority === 'HIGH') return 'bg-orange-100 text-orange-800'
  return ''
}

function typeClass(type: string) {
  if (type === 'BUG') return 'border-red-300 text-red-700'
  if (type === 'ENHANCEMENT') return 'border-blue-300 text-blue-700'
  return ''
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

async function onTransition() {
  toast.success(t('tickets.toast.updated'))
  await refresh()
}

function onCommentAdded() {
  toast.success(t('comments.toast.added'))
}
</script>

<template>
  <div>
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <div v-else-if="ticket" class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Main content: 2/3 width on desktop, full width on mobile -->
      <div class="md:col-span-2 space-y-6">
        <div>
          <h1 class="text-2xl font-bold">{{ ticket.title }}</h1>
        </div>

        <div class="flex gap-2">
          <Badge
            :variant="ticket.status === 'REJECTED' ? 'destructive' : 'outline'"
            :class="statusClass(ticket.status)"
          >
            {{ t(`tickets.status.${ticket.status}`) }}
          </Badge>
          <Badge
            :variant="priorityVariant(ticket.priority)"
            :class="priorityClass(ticket.priority)"
          >
            {{ t(`tickets.priority.${ticket.priority}`) }}
          </Badge>
          <Badge variant="outline" :class="typeClass(ticket.type)">
            {{ t(`tickets.type.${ticket.type}`) }}
          </Badge>
        </div>

        <div v-if="ticket.description">
          <p class="text-sm text-muted-foreground mb-1">{{ t('tickets.detail.description') }}</p>
          <p class="whitespace-pre-wrap text-sm">{{ ticket.description }}</p>
        </div>

        <CommentThread
          :project-slug="slug"
          :ticket-ref="ref"
          @comment-added="onCommentAdded"
        />
      </div>

      <!-- Sidebar: 1/3 width on desktop, stacks below on mobile -->
      <div class="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-sm font-medium">{{ t('common.details') }}</CardTitle>
          </CardHeader>
          <CardContent class="space-y-3">
            <div>
              <p class="text-xs text-muted-foreground mb-1">{{ t('tickets.detail.assignee') }}</p>
              <div v-if="ticket.assignee" class="flex items-center gap-2">
                <Avatar class="h-6 w-6">
                  <AvatarFallback class="text-xs">
                    {{ ticket.assignee.name.charAt(0).toUpperCase() }}
                  </AvatarFallback>
                </Avatar>
                <span class="text-sm">{{ ticket.assignee.name }}</span>
              </div>
              <p v-else class="text-sm text-muted-foreground">{{ t('common.unassigned') }}</p>
            </div>

            <Separator />

            <div>
              <p class="text-xs text-muted-foreground mb-1">{{ t('tickets.detail.created') }}</p>
              <p class="text-sm">{{ formatDate(ticket.createdAt) }}</p>
            </div>

            <Separator />

            <div v-if="ticket.gitRefFile">
              <p class="text-xs text-muted-foreground mb-1">{{ t('tickets.detail.gitRef') }}</p>
              <a
                v-if="ticket.gitRefUrl"
                :href="ticket.gitRefUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-blue-500 hover:underline font-mono text-sm"
              >
                {{ ticket.gitRefFile }}<span v-if="ticket.gitRefLine">:{{ ticket.gitRefLine }}</span>
              </a>
              <span v-else class="font-mono text-sm text-muted-foreground">
                {{ ticket.gitRefFile }}<span v-if="ticket.gitRefLine">:{{ ticket.gitRefLine }}</span>
              </span>
            </div>
          </CardContent>
        </Card>

        <TicketActionPanel
          :ticket="ticket"
          :project-slug="slug"
          @transition="onTransition"
        />
      </div>
    </div>
  </div>
</template>
