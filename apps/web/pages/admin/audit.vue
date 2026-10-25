<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useAuditLog } from '~/composables/useAuditLog'
import type { AuditEntry } from '~/composables/useAuditLog'
import { AUDIT_ACTOR_TYPES, auditRouteQuery, parseAuditRoute, principalLabel, withFilter } from '~/lib/audit-log'
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
const { entries, keys, load, loadKeys } = useAuditLog()

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
 * A failed load rethrows so the caller knows the page is stale: the table keeps its last good rows
 * (the `useAdminUsers` pattern) and US-006 renders the refusal, error and empty states. US-004 has
 * no error copy yet, so the failure is deliberately not surfaced here.
 */
async function attempt(task: Promise<void>): Promise<void> {
  try {
    await task
  } catch {
    // Nothing to do: the previous page stays on screen until the next successful load.
  }
}

onMounted(() => {
  void attempt(load(filters.value))
  void attempt(loadKeys())
})

watch(filterKey, () => { void attempt(load(filters.value)) })
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

    <Table data-testid="audit-table">
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('admin.audit.column.time') }}</TableHead>
          <TableHead>{{ t('admin.audit.column.key') }}</TableHead>
          <TableHead>{{ t('admin.audit.column.actor') }}</TableHead>
          <TableHead>{{ t('admin.audit.column.project') }}</TableHead>
          <TableHead>{{ t('admin.audit.column.resource') }}</TableHead>
          <TableHead>{{ t('admin.audit.column.summary') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="entry in entries" :key="entry.id" data-testid="audit-row">
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
      </TableBody>
    </Table>
  </div>
</template>
