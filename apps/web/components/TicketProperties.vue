<script setup lang="ts">
import { computed, ref as vueRef } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import TicketActionPanel from '~/components/TicketActionPanel.vue'
import { extractApiError } from '~/composables/useApi'
import { safeHref } from '~/lib/safe-url'
import { apiPath } from '~/lib/api-path'

type TicketType = 'BUG' | 'ENHANCEMENT' | 'TASK' | 'QUESTION'
type TicketPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
type TicketStatus = 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'

interface Assignee {
  kind: 'user' | 'agent'
  id: string
  name: string
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
  /** C9 1b: `vcs` (default) or `fleet`; fleet links name the job that opened the PR. */
  source?: string
  jobId?: string | null
}

interface Label {
  id: string
  name: string
  color: string
}

interface Ticket {
  id: string
  ref: string
  title: string
  description?: string | null
  type: TicketType
  priority: TicketPriority
  status: TicketStatus
  assignee?: Assignee | null
  allowedActions?: Array<'verify' | 'start' | 'fix' | 'verify-fix' | 'reject' | 'close'>
  createdAt: string
  gitRefFile?: string | null
  gitRefLine?: number | null
  gitRefUrl?: string | null
  externalVcsUrl?: string | null
  links?: TicketLink[]
  labels?: Array<{ id: string; name: string; color: string }>
  [key: string]: unknown
}

const props = defineProps<{
  ticket: Ticket
  projectSlug: string
  ticketRef: string
  ticketLinks: TicketLink[]
  allLabels: Label[]
  canWork: boolean
  canManage: boolean
}>()

const emit = defineEmits<{
  (e: 'transition'): void
  (e: 'changed'): void
}>()

const { $api } = useApi()
const { t, locale } = useI18n()
const toast = useAppToast()

const PR_STATE_CLASS: Record<string, string> = {
  merged: 'text-status-done border-status-done/40',
  open: 'text-status-active border-status-active/40',
  draft: 'text-muted-foreground',
  closed: 'text-status-rejected border-status-rejected/40',
}

const chipClass = 'inline-flex items-center gap-1.5 h-[22px] rounded-full border border-border bg-card px-2.5 text-xs font-medium'
const panelClass = 'rounded-lg border bg-card overflow-hidden'
const panelHeadingClass = 'flex items-center justify-between gap-2 border-b px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const panelBodyClass = 'flex flex-col gap-2.5 p-3.5'
const summaryChevronClass = 'h-4 w-4 lg:hidden'

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function extractIssueNumber(url: string): string | null {
  const parts = url.split('/')
  return parts[parts.length - 1] || null
}

function extractPrNumber(externalRef: string | null): string | null {
  if (!externalRef) return null
  const parts = externalRef.split('#')
  return parts[parts.length - 1] || null
}

function extractBranchName(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] || ''
}

function extractCommitSha(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1]?.substring(0, 7) || ''
}

function prStateClass(state: string | null | undefined): string {
  return [chipClass, PR_STATE_CLASS[state ?? ''] ?? 'text-muted-foreground'].join(' ')
}

const vcsPullRequestLinks = computed(() => {
  if (!props.ticketLinks) return []
  return props.ticketLinks.filter(link => link.linkType === 'pr' || (!link.linkType && link.provider === 'github' && link.prNumber))
})

const vcsBranchLinks = computed(() => {
  if (!props.ticketLinks) return []
  return props.ticketLinks.filter(link => link.linkType === 'branch')
})

const vcsCommitLinks = computed(() => {
  if (!props.ticketLinks) return []
  return props.ticketLinks
    .filter(link => link.linkType === 'commit')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
})

const plainLinks = computed(() => {
  if (!props.ticketLinks) return []
  const grouped = new Set(vcsPullRequestLinks.value.concat(vcsBranchLinks.value, vcsCommitLinks.value).map(l => l.id))
  return props.ticketLinks.filter(link => !grouped.has(link.id))
})

const hasLinkedSection = computed(() =>
  vcsPullRequestLinks.value.length > 0 ||
  vcsBranchLinks.value.length > 0 ||
  vcsCommitLinks.value.length > 0 ||
  plainLinks.value.length > 0,
)

const assigneeUserId = vueRef('')
const assigning = vueRef(false)

async function assignTicket() {
  if (!assigneeUserId.value.trim()) return
  assigning.value = true
  try {
    await $api.post(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/assign`, { userId: assigneeUserId.value.trim() })
    toast.success(t('tickets.toast.assigned'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    assigning.value = false
  }
}

async function unassignTicket() {
  assigning.value = true
  try {
    await $api.post(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/assign`, {})
    toast.success(t('tickets.toast.unassigned'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    assigning.value = false
  }
}

const deletingTicket = vueRef(false)
async function deleteTicket() {
  if (!window.confirm(t('tickets.delete.confirm'))) return
  deletingTicket.value = true
  try {
    await $api.delete(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}`)
    toast.success(t('tickets.delete.success'))
    await navigateTo(`/${props.projectSlug}`)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    deletingTicket.value = false
  }
}

const selectedLabelId = vueRef('')
const assigningLabel = vueRef(false)

async function assignLabel() {
  if (!selectedLabelId.value) return
  assigningLabel.value = true
  try {
    await $api.post(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/labels`, { labelId: selectedLabelId.value })
    selectedLabelId.value = ''
    toast.success(t('labels.toast.assigned'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    assigningLabel.value = false
  }
}

async function removeLabel(labelId: string) {
  try {
    await $api.delete(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/labels/${labelId}`)
    toast.success(t('labels.toast.unassigned'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

const newLinkUrl = vueRef('')
const newLinkType = vueRef('pr')
const addingLink = vueRef(false)

async function addLink() {
  if (!newLinkUrl.value.trim()) return
  addingLink.value = true
  try {
    await $api.post(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/links`, {
      url: newLinkUrl.value.trim(),
      linkType: newLinkType.value,
    })
    newLinkUrl.value = ''
    toast.success(t('tickets.links.toast.added'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    addingLink.value = false
  }
}

async function removeLink(linkId: string) {
  try {
    await $api.delete(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/links/${linkId}`)
    toast.success(t('tickets.links.toast.deleted'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}
</script>

<template>
  <div class="min-w-0 space-y-3">
    <section :class="panelClass" aria-label="Next step">
      <h3 :class="panelHeadingClass">{{ t('tickets.detail.nextStep') }}</h3>
      <div :class="panelBodyClass">
        <p class="text-xs text-muted-foreground">{{ t('tickets.detail.nextHint') }}</p>
        <TicketActionPanel
          :ticket="ticket"
          :project-slug="projectSlug"
          @transition="emit('transition')"
        />
      </div>
    </section>

    <details :class="panelClass" open>
      <summary :class="[panelHeadingClass, 'cursor-pointer list-none lg:pointer-events-none']">
        {{ t('tickets.detail.properties') }}
        <ChevronDown :class="summaryChevronClass" aria-hidden="true" />
      </summary>
      <div :class="panelBodyClass">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">{{ t('tickets.detail.assignee') }}</span>
          <div v-if="ticket.assignee" class="flex items-center gap-1.5 text-sm font-medium">
            <Avatar class="h-5 w-5">
              <AvatarFallback class="text-[10px]">
                {{ ticket.assignee.name.charAt(0).toUpperCase() }}
              </AvatarFallback>
            </Avatar>
            <span class="truncate">{{ ticket.assignee.name }}</span>
          </div>
          <span v-else class="text-sm text-muted-foreground">{{ t('common.unassigned') }}</span>
        </div>
        <div v-if="canWork" class="space-y-2 border-t pt-2.5">
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

        <div class="flex items-center justify-between gap-2 border-t pt-2.5">
          <span class="text-xs text-muted-foreground">{{ t('tickets.detail.created') }}</span>
          <span class="text-sm font-medium">{{ formatDate(ticket.createdAt) }}</span>
        </div>

        <div v-if="ticket.gitRefFile" class="flex items-center justify-between gap-2 border-t pt-2.5">
          <span class="text-xs text-muted-foreground">{{ t('tickets.detail.gitRef') }}</span>
          <a
            v-if="ticket.gitRefUrl"
            :href="safeHref(ticket.gitRefUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="truncate font-mono text-sm text-accent-foreground underline-offset-2 hover:underline"
          >
            {{ ticket.gitRefFile }}<span v-if="ticket.gitRefLine">:{{ ticket.gitRefLine }}</span>
          </a>
          <span v-else class="truncate font-mono text-sm text-muted-foreground">
            {{ ticket.gitRefFile }}<span v-if="ticket.gitRefLine">:{{ ticket.gitRefLine }}</span>
          </span>
        </div>

        <div v-if="ticket.externalVcsUrl" class="flex items-center justify-between gap-2 border-t pt-2.5">
          <span class="text-xs text-muted-foreground">{{ t('common.details') }}</span>
          <a
            :href="safeHref(ticket.externalVcsUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="truncate text-sm text-accent-foreground underline-offset-2 hover:underline"
          >
            {{ t('tickets.detail.syncedFromGithub', { issue: extractIssueNumber(ticket.externalVcsUrl) ?? 'unknown' }) }}
          </a>
        </div>
      </div>
    </details>

    <details :class="panelClass" open>
      <summary :class="[panelHeadingClass, 'cursor-pointer list-none lg:pointer-events-none']">
        {{ t('labels.title') }}
        <ChevronDown :class="summaryChevronClass" aria-hidden="true" />
      </summary>
      <div :class="panelBodyClass">
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="label in ticket.labels"
            :key="label.id"
            type="button"
            class="inline-flex h-[22px] items-center rounded-full border px-2.5 text-xs font-medium"
            :class="canWork ? 'cursor-pointer' : 'cursor-default'"
            :style="{ borderColor: label.color, color: label.color }"
            :disabled="!canWork"
            @click="canWork && removeLabel(label.id)"
          >
            {{ label.name }}
          </button>
          <span v-if="!ticket.labels || ticket.labels.length === 0" class="text-xs text-muted-foreground">{{ t('labels.empty') }}</span>
        </div>
        <div v-if="canWork" class="flex items-center gap-2 border-t pt-2.5">
          <Select v-model="selectedLabelId">
            <SelectTrigger class="w-[150px]" :aria-label="t('tickets.labels.select')">
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
    </details>

    <details v-if="hasLinkedSection" :class="panelClass" open>
      <summary :class="[panelHeadingClass, 'cursor-pointer list-none lg:pointer-events-none']">
        {{ t('tickets.detail.linked') }}
        <ChevronDown :class="summaryChevronClass" aria-hidden="true" />
      </summary>
      <div :class="panelBodyClass">
        <div v-for="link in vcsPullRequestLinks" :key="link.id" class="flex items-center justify-between gap-2 text-sm" data-link-type="pr">
          <span class="flex min-w-0 items-center gap-1.5">
            <a
              :href="safeHref(link.url)"
              target="_blank"
              rel="noopener noreferrer"
              class="truncate text-accent-foreground underline-offset-2 hover:underline"
            >
              {{ t('tickets.pr.badge', { number: (link.prNumber || extractPrNumber(link.externalRef)) ?? 'unknown' }) }}
            </a>
            <span v-if="link.prState" :class="prStateClass(link.prState)">{{ t(`tickets.pr.status.${link.prState}`) }}</span>
            <NuxtLink
              v-if="link.source === 'fleet' && link.jobId"
              :to="`/${projectSlug}/fleet/jobs/${link.jobId}`"
              :class="[chipClass, 'text-muted-foreground hover:bg-muted']"
              data-testid="ticket-link-via-fleet"
            >{{ t('fleet.tickets.viaFleet') }}</NuxtLink>
            <span v-else-if="link.source === 'fleet'" :class="[chipClass, 'text-muted-foreground']" data-testid="ticket-link-via-fleet">{{ t('fleet.tickets.viaFleet') }}</span>
          </span>
          <Button size="sm" variant="ghost" class="text-status-rejected" @click="removeLink(link.id)">
            {{ t('common.delete') }}
          </Button>
        </div>

        <div v-for="link in vcsBranchLinks" :key="link.id" class="flex items-center justify-between gap-2 text-sm" data-link-type="branch">
          <a
            :href="safeHref(link.url)"
            target="_blank"
            rel="noopener noreferrer"
            class="truncate font-mono text-accent-foreground underline-offset-2 hover:underline"
          >
            {{ extractBranchName(link.url) }}
          </a>
          <Button size="sm" variant="ghost" class="text-status-rejected" @click="removeLink(link.id)">
            {{ t('common.delete') }}
          </Button>
        </div>

        <div v-for="link in vcsCommitLinks" :key="link.id" class="flex items-center justify-between gap-2 text-sm" data-link-type="commit">
          <span class="flex min-w-0 items-center gap-1.5">
            <a
              :href="safeHref(link.url)"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-accent-foreground underline-offset-2 hover:underline"
            >
              {{ extractCommitSha(link.url) }}
            </a>
            <span v-if="link.title" class="truncate text-xs text-muted-foreground">{{ link.title }}</span>
          </span>
          <Button size="sm" variant="ghost" class="text-status-rejected" @click="removeLink(link.id)">
            {{ t('common.delete') }}
          </Button>
        </div>

        <div v-for="link in plainLinks" :key="link.id" class="flex items-center justify-between gap-2 text-sm">
          <a :href="safeHref(link.url)" target="_blank" rel="noopener noreferrer" class="truncate text-accent-foreground underline-offset-2 hover:underline">
            {{ link.url }}
          </a>
          <Button size="sm" variant="ghost" class="text-status-rejected" @click="removeLink(link.id)">
            {{ t('common.delete') }}
          </Button>
        </div>

        <div v-if="canWork" class="flex items-center gap-2 border-t pt-2.5">
          <Input v-model="newLinkUrl" :placeholder="t('tickets.links.placeholder')" />
          <Select v-model="newLinkType">
            <SelectTrigger class="w-[110px]" :aria-label="t('tickets.links.type')">
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
    </details>

    <div v-if="canManage" :class="panelClass" class="p-3.5">
      <Button variant="destructive" class="w-full" :disabled="deletingTicket" @click="deleteTicket">
        {{ deletingTicket ? t('common.loading') : t('tickets.delete.button') }}
      </Button>
    </div>
  </div>
</template>
