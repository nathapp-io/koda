<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-vue-next'
import AuditEntryDetail from '~/components/audit/AuditEntryDetail.vue'
import { useAuditLog } from '~/composables/useAuditLog'
import type { AuditEntry } from '~/composables/useAuditLog'
import { ApiError, extractApiError } from '~/composables/useApi'
import { AUDIT_ACTOR_TYPES, auditRouteQuery, parseAuditRoute, principalLabel, relatedFilters, withFilter } from '~/lib/audit-log'
import type { AuditFilters } from '~/lib/audit-log'

definePageMeta({ layout: 'default' })

/**
 * Permissions P2 spec §6: every write the API recorded, filtered by actor, project, resource, key
 * and date. The URL holds the filters, so a reader can share or reload a view; nothing here polls
 * or streams — the page loads on mount, on a URL change, and (US-006) on Refresh.
 */
const route = useRoute()
const router = useRouter()
const i18n = useI18n()
const { t } = i18n
const toast = useAppToast()
const { entries, keys, hasNext, pending, load, loadKeys } = useAuditLog()

/** Set when the API refuses `GET /audit` with a permission error: the page is admin-only. */
const adminOnly = ref(false)

/**
 * True once a `GET /audit` request has answered successfully. The composable's `pending` is shared
 * with the key list (and clears on a failure too), so it cannot say whether the log was read: only
 * this flag lets the page call the log empty, and a failed request never does.
 */
const loaded = ref(false)

/** The URL query is the only filter state. */
const filters = computed(() => parseAuditRoute(route.query))

/** The filters a load depends on; the watcher compares this instead of the object identity. */
const filterKey = computed(() => JSON.stringify(auditRouteQuery(filters.value)))

const keyOptions = computed(() => {
  const options = [
    { value: '', label: t('admin.audit.filter.allKeys') },
    ...keys.value.map((key) => ({ value: key, label: key })),
  ]
  // A key from a hand-edited URL — or a key list that failed to load — stays selectable, so the
  // select never blanks out while the table is filtered by it.
  if (filters.value.key !== '' && !keys.value.includes(filters.value.key)) {
    options.push({ value: filters.value.key, label: filters.value.key })
  }
  return options
})

const actorTypeOptions = computed(() => [
  { value: '', label: t('admin.audit.filter.allActorTypes') },
  ...AUDIT_ACTOR_TYPES.map((type) => ({ value: type, label: t(`admin.audit.actorType.${type}`) })),
])

/** The id filters a reader can remove without hunting for the control that set them. */
type ChipFilter = 'actor' | 'approver' | 'project' | 'resource' | 'correlation'

interface AuditChip {
  /** Which filter the chip stands for: its `data-filter`, and its kind label's key suffix. */
  filter: ChipFilter
  /** The resolved name the table shows for that id, or the raw id when nothing loaded carries it. */
  label: string
  /** The filters its remove button clears — a chip spans the pair a composite filter needs. */
  clear: Partial<Omit<AuditFilters, 'page'>>
}

/**
 * A resolved display name, or the id it stands for. A missing entry, a principal the API could not
 * name and a SYSTEM component all land on the id: the chip must always say what is being filtered.
 */
function nameOrId(name: string | null | undefined, id: string): string {
  const label = typeof name === 'string' ? name.trim() : ''
  return label.length > 0 ? label : id
}

/**
 * One chip per active id filter, in the filter order. The name is read from the first loaded entry
 * carrying that id — the same `display.*` block the table row uses — so a chip never needs a second
 * request: a name the current page cannot resolve simply falls back to the id.
 */
const chips = computed<AuditChip[]>(() => {
  const current = filters.value
  const loaded = entries.value
  const list: AuditChip[] = []
  if (current.actorId !== '') {
    const entry = loaded.find((row) => row.actor.id === current.actorId)
    list.push({ filter: 'actor', label: nameOrId(entry?.display.actor, current.actorId), clear: { actorType: '', actorId: '' } })
  }
  if (current.approverId !== '') {
    const entry = loaded.find((row) => row.approval.approverId === current.approverId)
    list.push({ filter: 'approver', label: nameOrId(entry?.display.approver, current.approverId), clear: { approverId: '' } })
  }
  if (current.projectId !== '') {
    const entry = loaded.find((row) => row.projectId === current.projectId)
    list.push({ filter: 'project', label: nameOrId(entry?.display.project?.slug, current.projectId), clear: { projectId: '' } })
  }
  // A resource is one filter written as two parameters, and a hand-edited URL may carry only one.
  const resource = [current.resourceType, current.resourceId].filter((part) => part !== '')
  if (resource.length > 0) {
    list.push({ filter: 'resource', label: resource.join('/'), clear: { resourceType: '', resourceId: '' } })
  }
  if (current.correlationId !== '') {
    list.push({ filter: 'correlation', label: current.correlationId, clear: { correlationId: '' } })
  }
  return list
})

/**
 * The active locale for a row's time. The i18n instance hands it over as `locale`; when it offers
 * none the runtime's own locale is the honest fallback, never a thrown RangeError.
 */
const activeLocale = computed((): string => {
  const value = (i18n as unknown as { locale?: { value?: unknown } }).locale?.value
  return typeof value === 'string' ? value : ''
})

function localTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleString(activeLocale.value === '' ? undefined : activeLocale.value)
}

function actorLabel(entry: AuditEntry): string {
  return principalLabel(entry.actor, entry.display.actor)
}

/** The person a decomposed action was performed for; the id when the principal no longer resolves. */
function onBehalfLabel(entry: AuditEntry): string {
  return entry.onBehalfOf === null ? '' : principalLabel(entry.onBehalfOf, entry.display.onBehalfOf)
}

function projectLabel(entry: AuditEntry): string {
  return entry.display.project?.slug ?? entry.projectId ?? '-'
}

/**
 * Every control writes the URL and nothing else: the query watcher does the loading, so one filter
 * change is exactly one request and `page` always restarts at 1 (`withFilter`).
 */
function apply(patch: Partial<Omit<AuditFilters, 'page'>>): void {
  void router.replace({ query: auditRouteQuery(withFilter(filters.value, patch)) })
}

function setKey(value: string): void {
  apply({ key: value })
}

function setActorType(value: string): void {
  // Only the four values the API accepts reach the URL; anything else clears the filter.
  apply({ actorType: AUDIT_ACTOR_TYPES.find((type) => type === value) ?? '' })
}

function setFrom(value: string): void {
  apply({ from: value })
}

function setTo(value: string): void {
  apply({ to: value })
}

function filterByActor(entry: AuditEntry): void {
  apply({ actorType: entry.actor.type, actorId: entry.actor.id })
}

function filterByProject(entry: AuditEntry): void {
  const projectId = entry.projectId ?? ''
  if (projectId !== '') apply({ projectId })
}

function filterByResource(entry: AuditEntry): void {
  apply({ resourceType: entry.resourceType, resourceId: entry.resourceId })
}

/**
 * The row whose detail block is open (US-007). One at a time: an audit reader compares one write's
 * provenance at a time, and the table is already dense. The id is not reset on a reload, so a
 * Refresh — which returns the same rows — leaves the block the reader opened open.
 */
const expandedEntryId = ref<string | null>(null)

function toggleDetail(entry: AuditEntry): void {
  expandedEntryId.value = expandedEntryId.value === entry.id ? null : entry.id
}

/**
 * "Show related" is a jump, not a narrowing: every write of one request or run is the question, so
 * the URL becomes that correlation filter alone (`relatedFilters` drops the other filters and the
 * page number), and the query watcher does the single load that follows.
 */
function showRelated(correlationId: string): void {
  void router.replace({ query: auditRouteQuery(relatedFilters(correlationId)) })
}

/**
 * A failed load rethrows so the caller knows the page is stale: the table keeps its last good rows
 * (the `useAdminUsers` pattern) and the refusal, error and empty states render around it.
 *
 * `ApiError.code` is the envelope `ret`, not the HTTP status: a 403 from the permission guards
 * arrives as ret 40003 (the `pages/admin/roles.vue` predicate). A refusal is not an error to toast —
 * the page says who may read the log; anything else (a reversed window, a 500) is an API error worth
 * reading, so it is toasted with `extractApiError`, never the raw message.
 */
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

/**
 * Load the current filters. `adminOnly` is only cleared by a load that actually succeeded: a
 * refusal hides the table even when an earlier load filled it, and it stays hidden until the API
 * lets the reader read again.
 */
async function reload(): Promise<void> {
  try {
    await load(filters.value)
    adminOnly.value = false
    loaded.value = true
  } catch (err: unknown) {
    if (isForbidden(err)) {
      adminOnly.value = true
      return
    }
    toast.error(extractApiError(err))
  }
}

/**
 * The key list feeds the key select only, so its failure is toasted and nothing else changes: the
 * entries the reader is studying stay on screen (the two loads are deliberately not coupled).
 */
async function reloadKeys(): Promise<void> {
  try {
    await loadKeys()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

/** Refresh is the one control that loads without touching the URL: same filters, one more request. */
function refresh(): void {
  void reload()
}

/**
 * Paging writes `page` into the URL like every other control, so `auditRouteQuery` omits page 1 and
 * keeps the filters the reader has set.
 */
function setPage(page: number): void {
  void router.replace({ query: auditRouteQuery({ ...filters.value, page: Math.max(1, page) }) })
}

/**
 * An empty log is a *successful* read with no records: `loaded` gates it, so a failed request is
 * only ever the error toast, never a claim that nothing was written.
 */
const isEmpty = computed(() => loaded.value && !pending.value && entries.value.length === 0)

onMounted(() => {
  void reload()
  void reloadKeys()
})

watch(filterKey, () => { void reload() })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('admin.audit.title')" :subtitle="t('admin.audit.subtitle')" />

    <FilterBar columns="4">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground" for="audit-key-filter">{{ t('admin.audit.filter.key') }}</label>
        <FleetNativeSelect id="audit-key-filter" :model-value="filters.key" :options="keyOptions" testid="audit-key-filter" @update:model-value="setKey" />
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground" for="audit-actor-type-filter">{{ t('admin.audit.filter.actorType') }}</label>
        <FleetNativeSelect id="audit-actor-type-filter" :model-value="filters.actorType" :options="actorTypeOptions" testid="audit-actor-type-filter" @update:model-value="setActorType" />
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground" for="audit-from">{{ t('admin.audit.filter.from') }}</label>
        <Input id="audit-from" :model-value="filters.from" type="date" data-testid="audit-from" @update:model-value="setFrom" />
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground" for="audit-to">{{ t('admin.audit.filter.to') }}</label>
        <Input id="audit-to" :model-value="filters.to" type="date" data-testid="audit-to" @update:model-value="setTo" />
      </div>

      <div class="flex items-end">
        <Button variant="outline" data-testid="audit-refresh" @click="refresh">
          <RefreshCw class="mr-2 h-4 w-4" />{{ t('admin.audit.refresh') }}
        </Button>
      </div>
    </FilterBar>

    <div v-if="chips.length > 0" class="flex flex-wrap items-center gap-1.5" data-testid="audit-chips">
      <span
        v-for="chip in chips"
        :key="chip.filter"
        class="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
        data-testid="audit-chip"
        :data-filter="chip.filter"
      >
        <span class="text-muted-foreground">{{ t(`admin.audit.chip.${chip.filter}`) }}</span>
        <span class="font-medium">{{ chip.label }}</span>
        <button
          type="button"
          class="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
          data-testid="audit-chip-remove"
          :aria-label="t('admin.audit.chip.remove', { filter: chip.label })"
          @click="apply(chip.clear)"
        >
          <X class="size-3" />
        </button>
      </span>
    </div>

    <p v-if="adminOnly" class="text-sm text-muted-foreground" data-testid="audit-admin-only">{{ t('admin.audit.adminOnly') }}</p>

    <template v-else>
      <LoadingState v-if="pending && entries.length === 0" />

      <p v-else-if="isEmpty" class="text-sm text-muted-foreground" data-testid="audit-empty">{{ t('admin.audit.empty') }}</p>

      <Table v-else data-testid="audit-table">
        <TableHeader>
          <TableRow>
            <TableHead class="w-8" />
            <TableHead>{{ t('admin.audit.column.time') }}</TableHead>
            <TableHead>{{ t('admin.audit.column.key') }}</TableHead>
            <TableHead>{{ t('admin.audit.column.actor') }}</TableHead>
            <TableHead>{{ t('admin.audit.column.project') }}</TableHead>
            <TableHead>{{ t('admin.audit.column.resource') }}</TableHead>
            <TableHead>{{ t('admin.audit.column.summary') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="entry in entries" :key="entry.id">
            <TableRow data-testid="audit-row">
              <TableCell class="w-8 align-top">
                <button
                  type="button"
                  class="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  data-testid="audit-expand"
                  :aria-expanded="expandedEntryId === entry.id ? 'true' : 'false'"
                  :aria-label="t('admin.audit.expand')"
                  :title="t('admin.audit.expand')"
                  @click="toggleDetail(entry)"
                >
                  <ChevronDown v-if="expandedEntryId === entry.id" class="h-4 w-4" />
                  <ChevronRight v-else class="h-4 w-4" />
                </button>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ localTime(entry.createdAt) }}</TableCell>
              <TableCell><code class="text-xs">{{ entry.key }}</code></TableCell>
              <TableCell>
                <button type="button" class="flex flex-wrap items-center gap-1.5 text-left hover:underline" data-testid="audit-actor" :title="t('admin.audit.filter.byActor')" @click="filterByActor(entry)">
                  <span>{{ actorLabel(entry) }}</span>
                  <Badge variant="secondary">{{ t(`admin.audit.actorType.${entry.actor.type}`) }}</Badge>
                  <span v-if="entry.onBehalfOf" class="text-xs text-muted-foreground">{{ t('admin.audit.onBehalfOf', { name: onBehalfLabel(entry) }) }}</span>
                </button>
              </TableCell>
              <TableCell>
                <button v-if="entry.projectId" type="button" class="text-left hover:underline" data-testid="audit-project" :title="t('admin.audit.filter.byProject')" @click="filterByProject(entry)">{{ projectLabel(entry) }}</button>
                <span v-else class="text-muted-foreground">{{ projectLabel(entry) }}</span>
              </TableCell>
              <TableCell>
                <button type="button" class="flex flex-wrap items-center gap-1 text-left hover:underline" data-testid="audit-resource" :title="t('admin.audit.filter.byResource')" @click="filterByResource(entry)">
                  <code class="text-xs">{{ entry.resourceType }}</code>
                  <code class="text-xs text-muted-foreground">{{ entry.resourceId }}</code>
                </button>
              </TableCell>
              <TableCell class="text-sm">{{ entry.summary ?? '' }}</TableCell>
            </TableRow>
            <!-- The provenance and approval block. `AuditEntryDetail` is imported here on purpose: the
                 harness injects a fixed auto-import list, so only an explicit import proves this is the
                 real component (`roles.vue` imports `RoleEditorDialog` the same way). -->
            <TableRow v-if="expandedEntryId === entry.id" :data-entry="entry.id">
              <TableCell colspan="7" class="bg-muted/40">
                <AuditEntryDetail :entry="entry" @related="showRelated" />
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </Table>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" data-testid="audit-prev" :disabled="filters.page <= 1" @click="setPage(filters.page - 1)">
          {{ t('admin.audit.prev') }}
        </Button>
        <Button variant="outline" size="sm" data-testid="audit-next" :disabled="!hasNext" @click="setPage(filters.page + 1)">
          {{ t('admin.audit.next') }}
        </Button>
      </div>
    </template>
  </div>
</template>
