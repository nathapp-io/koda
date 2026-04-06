<script setup lang="ts">
import { marked } from 'marked'
import { computed, reactive } from 'vue'
import MarkdownEditor from '~/components/MarkdownEditor.vue'

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
  type: 'BUG' | 'ENHANCEMENT'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
  assignee?: Assignee | null
  createdAt: string
  gitRefFile?: string | null
  gitRefLine?: number | null
  gitRefUrl?: string | null
  externalVcsUrl?: string | null
  [key: string]: unknown
}

const route = useRoute()
const { t, locale } = useI18n()

const slug = route.params.project as string
const ref = route.params.ref as string

const { $api } = useApi()
const toast = useAppToast()

const { data: ticketData, pending, error, refresh } = useAsyncData(
  `ticket-${slug}-${ref}`,
  () => $api.get(`/projects/${slug}/tickets/${ref}`) as Promise<Ticket>,
)

const ticket = computed(() => ticketData.value ?? null)

const editState = reactive({
  isEditing: false,
  title: '',
  description: '',
  priority: 'MEDIUM' as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
})

function startEdit() {
  if (!ticket.value) return
  editState.title = ticket.value.title
  editState.description = ticket.value.description ?? ''
  editState.priority = ticket.value.priority
  editState.isEditing = true
}

function cancelEdit() {
  editState.isEditing = false
}

async function saveEdit() {
  if (!ticket.value) return
  try {
    await $api.patch(`/projects/${slug}/tickets/${ref}`, {
      title: editState.title,
      description: editState.description,
      priority: editState.priority,
    })
    await refresh()
    editState.isEditing = false
    toast.success(t('tickets.toast.updated'))
  } catch (error: unknown) {
    toast.error(t('tickets.toast.updateFailed'))
  }
}

const renderedDescription = computed(() => {
  if (!ticket.value?.description) return ''
  try {
    return marked(ticket.value.description)
  } catch {
    return ticket.value.description
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

function extractIssueNumber(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] || ''
}
</script>

<template>
  <div>
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <div v-else-if="ticket" class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Main content: 2/3 width on desktop, full width on mobile -->
      <div class="md:col-span-2 space-y-6">
        <div class="flex items-center justify-between">
          <div v-if="!editState.isEditing" class="flex-1">
            <h1 class="text-2xl font-bold">{{ ticket.title }}</h1>
          </div>
          <Input
            v-else
            v-model="editState.title"
            class="text-2xl font-bold"
            :placeholder="t('tickets.form.titlePlaceholder')"
          />
          <div class="flex gap-2 ml-4">
            <Button v-if="!editState.isEditing" variant="outline" size="sm" @click="startEdit">
              {{ t('common.edit') }}
            </Button>
            <template v-else>
              <Button variant="outline" size="sm" @click="cancelEdit">
                {{ t('common.cancel') }}
              </Button>
              <Button size="sm" @click="saveEdit">
                {{ t('common.save') }}
              </Button>
            </template>
          </div>
        </div>

        <div class="flex gap-2">
          <Badge
            :variant="ticket.status === 'REJECTED' ? 'destructive' : 'outline'"
            :class="statusClass(ticket.status)"
          >
            {{ t(`tickets.status.${ticket.status}`) }}
          </Badge>
          <Badge
            v-if="!editState.isEditing"
            :variant="priorityVariant(ticket.priority)"
            :class="priorityClass(ticket.priority)"
          >
            {{ t(`tickets.priority.${ticket.priority}`) }}
          </Badge>
          <Select v-else v-model="editState.priority">
            <SelectTrigger class="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CRITICAL">{{ t('tickets.priority.CRITICAL') }}</SelectItem>
              <SelectItem value="HIGH">{{ t('tickets.priority.HIGH') }}</SelectItem>
              <SelectItem value="MEDIUM">{{ t('tickets.priority.MEDIUM') }}</SelectItem>
              <SelectItem value="LOW">{{ t('tickets.priority.LOW') }}</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" :class="typeClass(ticket.type)">
            {{ t(`tickets.type.${ticket.type}`) }}
          </Badge>
        </div>

        <div v-if="ticket.description || editState.isEditing">
          <p class="text-sm text-muted-foreground mb-1">{{ t('tickets.detail.description') }}</p>
          <MarkdownEditor v-if="editState.isEditing" v-model="editState.description" />
          <p
            v-else
            class="whitespace-pre-wrap text-sm"
            v-html="renderedDescription"
          />
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

            <Separator v-if="ticket.externalVcsUrl" />

            <div v-if="ticket.externalVcsUrl">
              <p class="text-xs text-muted-foreground mb-1">{{ t('common.details') }}</p>
              <a
                :href="ticket.externalVcsUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-blue-500 hover:underline text-sm"
              >
                {{ t('tickets.detail.syncedFromGithub', { issue: extractIssueNumber(ticket.externalVcsUrl) }) }}
              </a>
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
