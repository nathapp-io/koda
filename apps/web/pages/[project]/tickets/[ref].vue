<script setup lang="ts">
import { marked } from 'marked'
import { LucidePencil } from 'lucide-vue-next'

definePageMeta({ layout: 'default' })

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
  type: 'BUG' | 'ENHANCEMENT' | 'TASK' | 'QUESTION'
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
const ticketRef = route.params.ref as string

const { $api } = useApi()
const toast = useAppToast()

const { data: ticketData, pending, error, refresh } = useAsyncData(
  `ticket-${slug}-${ticketRef}`,
  () => $api.get(`/projects/${slug}/tickets/${ticketRef}`) as Promise<Ticket>,
)

const ticket = computed(() => ticketData.value ?? null)

const isEditDialogOpen = ref(false)

const renderedDescription = computed(() => {
  if (!ticket.value?.description) return ''
  try {
    return marked.parse(ticket.value.description, { breaks: true, gfm: true }) as string
  } catch {
    return `<pre class="whitespace-pre-wrap">${ticket.value.description}</pre>`
  }
})

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
  if (type === 'TASK') return 'border-green-300 text-green-700'
  if (type === 'QUESTION') return 'border-yellow-300 text-yellow-700'
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

function onTicketSaved() {
  toast.success(t('tickets.toast.updated'))
  refresh()
}
</script>

<template>
  <div>
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <div v-else-if="ticket" class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Main content: 2/3 width on desktop, full width on mobile -->
      <div class="md:col-span-2 space-y-6">
        <div class="flex items-start justify-between gap-4">
          <h1 class="text-2xl font-bold">{{ ticket.title }}</h1>
          <Button variant="outline" size="sm" @click="isEditDialogOpen = true">
            <LucidePencil class="h-4 w-4 mr-1" />
            {{ t('common.edit') }}
          </Button>
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
          <div class="prose prose-sm max-w-none text-sm">
            <div v-html="renderedDescription" />
          </div>
        </div>

        <CommentThread
          :project-slug="slug"
          :ticket-ref="ticketRef"
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

    <EditTicketDialog
      v-if="ticket"
      :open="isEditDialogOpen"
      :ticket="ticket"
      :project-slug="slug"
      :ticket-ref="ticketRef"
      @update:open="isEditDialogOpen = $event"
      @saved="onTicketSaved"
    />
  </div>
</template>
