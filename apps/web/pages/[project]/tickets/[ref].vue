<script setup lang="ts">
import { marked } from 'marked'
import { computed, reactive } from 'vue'
import MarkdownEditor from '~/components/MarkdownEditor.vue'
import { extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'default' })

interface Assignee {
  id: string
  name: string
  email?: string
}

interface TicketLink {
  id: string
  ticketId: string
  url: string
  provider: string
  externalRef: string | null
  createdAt: string
  prState?: string | null
  prNumber?: number | null
  prUpdatedAt?: string | null
  linkType?: string
  title?: string
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
  links?: TicketLink[]
  labels?: Array<{ id: string; name: string; color: string }>
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

const { data: ticketLinksData, refresh: refreshTicketLinks } = useAsyncData(
  `ticket-links-${slug}-${ticketRef}`,
  () => $api.get(`/projects/${slug}/tickets/${ticketRef}/links`) as Promise<TicketLink[]>,
)

interface Label {
  id: string
  name: string
  color: string
}

const { data: allLabelsData, refresh: refreshAllLabels } = useAsyncData(
  `labels-for-ticket-${slug}`,
  () => $api.get(`/projects/${slug}/labels`) as Promise<Label[]>,
)

const ticket = computed(() => ticketData.value ?? null)
const ticketLinks = computed(() => ticketLinksData.value ?? [])
const ticketLabels = computed(() => ticket.value?.labels ?? [])
const allLabels = computed(() => allLabelsData.value ?? [])

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
    await $api.patch(`/projects/${slug}/tickets/${ticketRef}`, {
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

const githubPrLinks = computed(() => {
  if (!ticketLinks.value) return []
  return ticketLinks.value.filter(link => link.linkType === 'pr' || (!link.linkType && link.provider === 'github' && link.prNumber))
})

function extractPrNumber(externalRef: string | null): string {
  if (!externalRef) return ''
  const parts = externalRef.split('#')
  return parts[parts.length - 1] || ''
}

function extractRepoRef(externalRef: string | null): string {
  if (!externalRef) return ''
  const parts = externalRef.split('#')
  return parts[0] || ''
}

const githubPrLinksWithState = computed(() => {
  if (!ticketLinks.value) return []
  return ticketLinks.value.filter(link => (link.linkType === 'pr' || (!link.linkType && link.provider === 'github' && link.prNumber)) && link.prState)
})

function prStateClass(state: string | null | undefined): string {
  if (state === 'merged') return 'bg-green-100 text-green-800'
  if (state === 'open') return 'bg-blue-100 text-blue-800'
  if (state === 'draft') return 'bg-gray-100 text-gray-800'
  if (state === 'closed') return 'bg-red-100 text-red-800'
  return 'bg-gray-100 text-gray-800'
}

// VCS Link filtering by linkType
const vcsPullRequestLinks = computed(() => {
  if (!ticketLinks.value) return []
  return ticketLinks.value.filter(link => link.linkType === 'pr' || (!link.linkType && link.provider === 'github' && link.prNumber))
})

const vcsBranchLinks = computed(() => {
  if (!ticketLinks.value) return []
  return ticketLinks.value.filter(link => link.linkType === 'branch')
})

const vcsCommitLinks = computed(() => {
  if (!ticketLinks.value) return []
  return ticketLinks.value
    .filter(link => link.linkType === 'commit')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
})

function extractBranchName(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] || ''
}

function extractCommitSha(url: string): string {
  // Extract SHA from commit URL like https://github.com/owner/repo/commit/abc123
  const parts = url.split('/')
  return parts[parts.length - 1]?.substring(0, 7) || ''
}

const assigneeUserId = ref('')
const assigning = ref(false)

async function assignTicket() {
  if (!assigneeUserId.value.trim()) return
  assigning.value = true
  try {
    await $api.post(`/projects/${slug}/tickets/${ticketRef}/assign`, { userId: assigneeUserId.value.trim() })
    toast.success(t('tickets.toast.assigned'))
    await refresh()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    assigning.value = false
  }
}

async function unassignTicket() {
  assigning.value = true
  try {
    await $api.post(`/projects/${slug}/tickets/${ticketRef}/assign`, {})
    toast.success(t('tickets.toast.unassigned'))
    await refresh()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    assigning.value = false
  }
}

const deletingTicket = ref(false)
async function deleteTicket() {
  if (!window.confirm(t('tickets.delete.confirm'))) return
  deletingTicket.value = true
  try {
    await $api.delete(`/projects/${slug}/tickets/${ticketRef}`)
    toast.success(t('tickets.delete.success'))
    await navigateTo(`/${slug}`)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    deletingTicket.value = false
  }
}

const selectedLabelId = ref('')
const assigningLabel = ref(false)

async function assignLabel() {
  if (!selectedLabelId.value) return
  assigningLabel.value = true
  try {
    await $api.post(`/projects/${slug}/tickets/${ticketRef}/labels`, { labelId: selectedLabelId.value })
    selectedLabelId.value = ''
    toast.success(t('labels.toast.assigned'))
    await refresh()
    await refreshAllLabels()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    assigningLabel.value = false
  }
}

async function removeLabel(labelId: string) {
  try {
    await $api.delete(`/projects/${slug}/tickets/${ticketRef}/labels/${labelId}`)
    toast.success(t('labels.toast.unassigned'))
    await refresh()
    await refreshAllLabels()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

const newLinkUrl = ref('')
const newLinkType = ref('pr')
const addingLink = ref(false)

async function addLink() {
  if (!newLinkUrl.value.trim()) return
  addingLink.value = true
  try {
    await $api.post(`/projects/${slug}/tickets/${ticketRef}/links`, {
      url: newLinkUrl.value.trim(),
      linkType: newLinkType.value,
    })
    newLinkUrl.value = ''
    toast.success(t('tickets.links.toast.added'))
    await refreshTicketLinks()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    addingLink.value = false
  }
}

async function removeLink(linkId: string) {
  try {
    await $api.delete(`/projects/${slug}/tickets/${ticketRef}/links/${linkId}`)
    toast.success(t('tickets.links.toast.deleted'))
    await refreshTicketLinks()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
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
          <template v-for="link in githubPrLinks" :key="link.id">
            <a
              :href="link.url"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-github-link-bg text-gitHub-link-text hover:bg-gitHub-link-bg/80 border border-gitHub-link-border"
            >
              <span>{{ t('tickets.pr.badge', { number: extractPrNumber(link.externalRef) }) }}</span>
            </a>
            <Badge v-if="link.prState" variant="outline" :class="prStateClass(link.prState)">
              {{ t(`tickets.pr.status.${link.prState}`) }}
            </Badge>
          </template>
        </div>

        <!-- PR Status Section -->
        <div v-for="link in githubPrLinksWithState" :key="link.id">
          <div v-if="link.prState === 'merged'" class="mt-4 p-4 border rounded-md bg-green-50">
            <div class="flex items-center gap-2 mb-2">
              <span class="w-2 h-2 rounded-full bg-green-500"></span>
              <span class="text-sm font-medium">{{ t('tickets.pr.status.merged') }}</span>
            </div>
            <p class="text-sm text-muted-foreground">
              {{ t('tickets.pr.mergedActivity', { repo: link.externalRef?.split('#')[0] || '', number: link.prNumber || extractPrNumber(link.externalRef), author: 'system' }) }}
            </p>
          </div>
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

        <div v-if="githubPrLinks.length > 0" class="space-y-1">
          <p
            v-for="link in githubPrLinks"
            :key="`pr-created-${link.id}`"
            class="text-sm text-muted-foreground"
          >
            {{ t('tickets.pr.created', { repo: extractRepoRef(link.externalRef), number: extractPrNumber(link.externalRef) }) }}
          </p>
        </div>

        <CommentThread
          :project-slug="slug"
          :ticket-ref="ticketRef"
          @comment-added="onCommentAdded"
        />

        <!-- VCS Links Section grouped by linkType -->
        <div v-if="vcsPullRequestLinks.length > 0 || vcsBranchLinks.length > 0 || vcsCommitLinks.length > 0" class="mt-6">
          <h3 class="text-lg font-semibold mb-3">{{ t('tickets.vcs.title') }}</h3>

          <!-- Pull Requests Subsection -->
          <div v-if="vcsPullRequestLinks.length > 0" class="mb-4" data-link-type="pr">
            <h4 class="text-sm font-medium text-muted-foreground mb-2">{{ t('tickets.vcs.pullRequests') }}</h4>
            <div v-for="link in vcsPullRequestLinks" :key="link.id" class="flex items-center gap-2 mb-2">
              <a
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-blue-500 hover:underline"
              >
                {{ t('tickets.pr.badge', { number: link.prNumber || extractPrNumber(link.externalRef) }) }}
              </a>
              <Badge v-if="link.prState" variant="outline" :class="prStateClass(link.prState)">
                {{ t(`tickets.pr.status.${link.prState}`) }}
              </Badge>
            </div>
          </div>

          <!-- Branches Subsection -->
          <div v-if="vcsBranchLinks.length > 0" class="mb-4" data-link-type="branch">
            <h4 class="text-sm font-medium text-muted-foreground mb-2">{{ t('tickets.vcs.branches') }}</h4>
            <div v-for="link in vcsBranchLinks" :key="link.id" class="mb-2">
              <a
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-blue-500 hover:underline"
              >
                {{ extractBranchName(link.url) }}
              </a>
            </div>
          </div>

          <!-- Commits Subsection -->
          <div v-if="vcsCommitLinks.length > 0" data-link-type="commit">
            <h4 class="text-sm font-medium text-muted-foreground mb-2">{{ t('tickets.vcs.commits') }}</h4>
            <div v-for="link in vcsCommitLinks" :key="link.id" class="mb-2">
              <a
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-blue-500 hover:underline font-mono text-sm"
              >
                {{ extractCommitSha(link.url) }}
              </a>
              <span v-if="link.title" class="text-sm text-muted-foreground ml-2">{{ link.title }}</span>
            </div>
          </div>
        </div>
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
              <div class="mt-2 space-y-2">
                <Input v-model="assigneeUserId" :placeholder="t('tickets.assign.userIdPlaceholder')" />
                <div class="flex items-center gap-2">
                  <Button size="sm" :disabled="assigning || !assigneeUserId.trim()" @click="assignTicket">
                    {{ t('tickets.assign.assign') }}
                  </Button>
                  <Button size="sm" variant="outline" :disabled="assigning" @click="unassignTicket">
                    {{ t('tickets.assign.unassign') }}
                  </Button>
                </div>
              </div>
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

            <Separator />

            <div class="space-y-2">
              <p class="text-xs text-muted-foreground">{{ t('labels.title') }}</p>
              <div class="flex flex-wrap gap-2">
                <Badge
                  v-for="label in ticketLabels"
                  :key="label.id"
                  variant="outline"
                  class="cursor-pointer"
                  :style="{ borderColor: label.color, color: label.color }"
                  @click="removeLabel(label.id)"
                >
                  {{ label.name }}
                </Badge>
                <span v-if="ticketLabels.length === 0" class="text-xs text-muted-foreground">{{ t('labels.empty') }}</span>
              </div>
              <div class="flex items-center gap-2">
                <Select v-model="selectedLabelId">
                  <SelectTrigger class="w-[180px]">
                    <SelectValue :placeholder="t('tickets.labels.select')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="label in allLabels" :key="label.id" :value="label.id">{{ label.name }}</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" :disabled="assigningLabel || !selectedLabelId" @click="assignLabel">
                  {{ t('tickets.labels.add') }}
                </Button>
              </div>
            </div>

            <Separator />

            <div class="space-y-2">
              <p class="text-xs text-muted-foreground">{{ t('tickets.links.title') }}</p>
              <div class="space-y-1">
                <div v-for="link in ticketLinks" :key="link.id" class="flex items-center justify-between gap-2 text-sm">
                  <a :href="link.url" target="_blank" rel="noopener noreferrer" class="truncate text-blue-500 hover:underline">
                    {{ link.url }}
                  </a>
                  <Button size="sm" variant="ghost" class="text-destructive" @click="removeLink(link.id)">
                    {{ t('common.delete') }}
                  </Button>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Input v-model="newLinkUrl" :placeholder="t('tickets.links.placeholder')" />
                <Select v-model="newLinkType">
                  <SelectTrigger class="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pr">pr</SelectItem>
                    <SelectItem value="branch">branch</SelectItem>
                    <SelectItem value="commit">commit</SelectItem>
                    <SelectItem value="url">url</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" :disabled="addingLink || !newLinkUrl.trim()" @click="addLink">
                  {{ t('tickets.links.add') }}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <TicketActionPanel
          :ticket="ticket"
          :project-slug="slug"
          @transition="onTransition"
        />
        <Button variant="destructive" class="w-full" :disabled="deletingTicket" @click="deleteTicket">
          {{ deletingTicket ? t('common.loading') : t('tickets.delete.button') }}
        </Button>
      </div>
    </div>
  </div>
</template>
