<script setup lang="ts">
import { computed, reactive, ref as vueRef, onMounted, onBeforeUnmount } from 'vue'
import TicketHeader from '~/components/TicketHeader.vue'
import TicketActivity from '~/components/TicketActivity.vue'
import TicketProperties from '~/components/TicketProperties.vue'
import { createDebouncer } from '~/lib/debounce'
import { apiPath } from '~/lib/api-path'

definePageMeta({ layout: 'default' })

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

const route = useRoute()
const { t } = useI18n()

const slug = route.params.project as string
const ref = route.params.ref as string

const { $api } = useApi()
const toast = useAppToast()

const { data: ticketData, pending, error, refresh } = useAsyncData(
  `ticket-${slug}-${ref}`,
  () => $api.get(apiPath`/projects/${slug}/tickets/${ref}`) as Promise<Ticket>,
)

const { data: ticketLinksData } = useAsyncData(
  `ticket-links-${slug}-${ref}`,
  () => $api.get(apiPath`/projects/${slug}/tickets/${ref}/links`) as Promise<TicketLink[]>,
)

interface Label {
  id: string
  name: string
  color: string
}

const { data: allLabelsData } = useAsyncData(
  `labels-for-ticket-${slug}`,
  () => $api.get(apiPath`/projects/${slug}/labels`) as Promise<Label[]>,
)

const ticket = computed(() => ticketData.value ?? null)

// Track 1 Slice 5: live updates for the open ticket. Never refresh(): it flips
// `pending`, which swaps the page for LoadingState and unmounts an open edit form.
const LIVE_RELOAD_DEBOUNCE_MS = 300
const ticketDeleted = vueRef(false)
const { data: liveComments } = useNuxtData(`comments-${slug}-${ref}`)

async function reloadTicketSilently() {
  try {
    ticketData.value = await ($api.get(apiPath`/projects/${slug}/tickets/${ref}`) as Promise<Ticket>)
  }
  catch {
    // The next live event or a resync retries.
  }
}

async function reloadCommentsSilently() {
  try {
    liveComments.value = await $api.get(apiPath`/projects/${slug}/tickets/${ref}/comments`)
  }
  catch {
    // The next live event or a resync retries.
  }
}

async function reloadLinksSilently() {
  try {
    ticketLinksData.value = await ($api.get(apiPath`/projects/${slug}/tickets/${ref}/links`) as Promise<TicketLink[]>)
  }
  catch {
    // The next live event or a resync retries.
  }
}

async function reloadLabelsSilently() {
  try {
    allLabelsData.value = await ($api.get(apiPath`/projects/${slug}/labels`) as Promise<Label[]>)
  }
  catch {
    // The next live event or a resync retries.
  }
}

const liveTicketReload = createDebouncer(() => { void reloadTicketSilently() }, LIVE_RELOAD_DEBOUNCE_MS)
onBeforeUnmount(() => liveTicketReload.cancel())

useProjectEvents(slug, {
  onEvent: (event) => {
    if (!ticket.value || event.ticketId !== ticket.value.id) return
    if (event.action === 'deleted') {
      ticketDeleted.value = true
      return
    }
    liveTicketReload.trigger()
    // Any ticket event may have changed the comment thread (transitions create
    // a VERIFICATION/FIX_REPORT/REVIEW comment), so reload it unconditionally.
    void reloadCommentsSilently()
  },
  onResync: () => {
    if (ticketDeleted.value) return
    liveTicketReload.trigger()
    void reloadCommentsSilently()
  },
})

const ticketLinks = computed(() => ticketLinksData.value ?? [])
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
    await $api.patch(apiPath`/projects/${slug}/tickets/${ref}`, {
      title: editState.title,
      description: editState.description,
      priority: editState.priority,
    })
    await refresh()
    editState.isEditing = false
    toast.success(t('tickets.toast.updated'))
  } catch {
    toast.error(t('tickets.toast.updateFailed'))
  }
}

// Controls follow the caller's role in THIS project (the API decides;
// this only avoids offering actions that would 403). useProjectViewerRole
// is SSR-friendly so canManage/viewerRole are populated before hydration —
// no flash of "no controls" → "controls appear" on first paint.
const { data: viewerRoleData } = useProjectViewerRole(slug)
const canManage = computed(() => viewerRoleData.value?.canManage === true)
const viewerRole = computed(() => viewerRoleData.value?.viewerRole ?? null)
const canWork = computed(() => canManage.value || viewerRole.value === 'DEVELOPER')

async function refetchAll() {
  // Silent reloads: refresh() would flip `pending` and swap the page for
  // LoadingState, unmounting the properties rail mid-interaction.
  await Promise.all([reloadTicketSilently(), reloadLinksSilently(), reloadLabelsSilently()])
}

async function onTransition() {
  toast.success(t('tickets.toast.updated'))
  await refetchAll()
}

function onPageKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && editState.isEditing) {
    cancelEdit()
    return
  }
  const target = event.target as HTMLElement | null
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
  if ((event.key === 'e' || event.key === 'E') && !editState.isEditing && ticket.value) {
    event.preventDefault()
    startEdit()
  }
}

onMounted(() => window.addEventListener('keydown', onPageKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onPageKeydown))
</script>

<template>
  <div>
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <div v-else-if="ticket" class="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
      <div class="min-w-0 space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
        <div
          v-if="ticketDeleted"
          role="status"
          data-testid="ticket-deleted-notice"
          class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-status-rejected"
        >
          {{ t('tickets.live.deleted') }}
        </div>
        <TicketHeader
          :ticket="ticket"
          :editing="editState.isEditing"
          :edit-title="editState.title"
          :edit-priority="editState.priority"
          @start-edit="startEdit"
          @cancel-edit="cancelEdit"
          @save="saveEdit"
          @update:edit-title="editState.title = $event"
          @update:edit-priority="editState.priority = $event"
        />
      </div>

      <div class="min-w-0 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[72px] lg:self-start">
        <TicketProperties
          :ticket="ticket"
          :project-slug="slug"
          :ticket-ref="ref"
          :ticket-links="ticketLinks"
          :all-labels="allLabels"
          :can-work="canWork"
          :can-manage="canManage"
          @transition="onTransition"
          @changed="refetchAll()"
        />
      </div>

      <div class="min-w-0 lg:col-span-2 lg:col-start-1 lg:row-start-2">
        <TicketActivity
          :ticket="ticket"
          :project-slug="slug"
          :ticket-ref="ref"
          :editing="editState.isEditing"
          :edit-description="editState.description"
          @update:edit-description="editState.description = $event"
        />
      </div>
    </div>
  </div>
</template>
