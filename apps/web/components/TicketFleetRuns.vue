<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'
import { createDebouncer } from '~/lib/debounce'
import { formatUsd, safePrUrl } from '~/lib/fleet-jobs'
import { affectsRuns, runPrState, runReason, shortSha } from '~/lib/fleet-ticket-links'
import type { TicketFleetJobDto } from '~/lib/fleet-types'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'

/** C9 §4 (D461): the ticket's fleet jobs, read live from FleetJob; hidden when there are none. */
const props = defineProps<{
  projectSlug: string
  ticketRef: string
  ticketId: string
  ticketLinks: ReadonlyArray<{ url: string; prState?: string | null }>
  canWork: boolean
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const { t } = useI18n()
const { $api } = useApi()
const toast = useAppToast()

const LIVE_RELOAD_DEBOUNCE_MS = 300
const runs = ref<TicketFleetJobDto[]>([])
const now = ref(new Date())
const unlinkTarget = ref<TicketFleetJobDto | null>(null)
const unlinking = ref(false)

/** P4: secondary content. A failed load keeps what is on screen; the next live event or resync retries. */
async function load(): Promise<void> {
  try {
    runs.value = await $api.get<TicketFleetJobDto[]>(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/fleet-jobs`)
    now.value = new Date()
  }
  catch {
    // Keep the last list.
  }
}

const liveReload = createDebouncer(() => { void load() }, LIVE_RELOAD_DEBOUNCE_MS)
onMounted(load)
onBeforeUnmount(() => liveReload.cancel())

useProjectEvents(props.projectSlug, {
  onEvent: (event) => {
    if (event.ticketId === props.ticketId) liveReload.trigger()
  },
  onFleetJob: (event) => {
    if (affectsRuns(event, runs.value.map(r => r.id))) liveReload.trigger()
  },
  onResync: () => liveReload.trigger(),
})

const rows = computed(() => runs.value.map(run => ({
  run,
  reason: runReason(run),
  prUrl: safePrUrl(run.resultPrUrl),
  prState: runPrState(run, props.ticketLinks),
  sha: shortSha(run.resultSha),
  at: run.finishedAt ?? run.queuedAt,
})))

function closeUnlink(open: boolean): void {
  if (!open) unlinkTarget.value = null
}

async function confirmUnlink(): Promise<void> {
  const target = unlinkTarget.value
  if (!target) return
  unlinking.value = true
  try {
    await $api.delete(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/fleet-jobs/${target.id}`)
    toast.success(t('fleet.tickets.unlinked'))
    emit('changed')
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    unlinking.value = false
    unlinkTarget.value = null
    await load()
  }
}
</script>

<template>
  <section v-if="runs.length > 0" class="overflow-hidden rounded-lg border bg-card" :aria-label="t('fleet.tickets.title')" data-testid="ticket-fleet-runs">
    <h2 class="border-b px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('fleet.tickets.title') }}</h2>
    <ul class="divide-y">
      <li v-for="row in rows" :key="row.run.id" class="flex flex-col gap-1.5 px-3.5 py-3 text-sm" data-testid="ticket-fleet-run" :data-job="row.run.id">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline" data-testid="ticket-fleet-run-command">{{ row.run.command }}</Badge>
          <FleetJobStateBadge :state="row.run.state" />
          <NuxtLink :to="`/${projectSlug}/fleet/jobs/${row.run.id}`" class="min-w-0 truncate font-medium text-primary underline-offset-4 hover:underline" data-testid="ticket-fleet-run-link">{{ row.run.feature }}</NuxtLink>
          <span class="ml-auto text-xs text-muted-foreground"><FleetAge :iso="row.at" :now="now" mode="ago" /></span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span v-if="row.run.resultBranch" class="break-all font-mono" data-testid="ticket-fleet-run-branch">{{ row.run.resultBranch }}<template v-if="row.sha"> ({{ row.sha }})</template></span>
          <span v-if="row.run.resultPrUrl" class="flex items-center gap-1.5" data-testid="ticket-fleet-run-pr">
            <a v-if="row.prUrl" :href="row.prUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline-offset-4 hover:underline">{{ t('fleet.tickets.pr') }}</a>
            <span v-else class="break-all">{{ row.run.resultPrUrl }}</span>
            <Badge v-if="row.prState" variant="outline" data-testid="ticket-fleet-run-pr-state" :data-state="row.prState">{{ t(`tickets.pr.status.${row.prState}`) }}</Badge>
          </span>
          <span data-testid="ticket-fleet-run-cost">{{ formatUsd(row.run.costUsd) }}</span>
        </div>
        <p v-if="row.reason" class="whitespace-pre-wrap break-words text-xs text-status-rejected" data-testid="ticket-fleet-run-reason">{{ row.reason }}</p>
        <div v-if="canWork" class="flex justify-end">
          <Button size="sm" variant="ghost" data-testid="ticket-fleet-run-unlink" @click="unlinkTarget = row.run">{{ t('fleet.tickets.unlink') }}</Button>
        </div>
      </li>
    </ul>

    <Dialog :open="unlinkTarget !== null" @update:open="closeUnlink">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ t('fleet.tickets.unlinkTitle') }}</DialogTitle>
          <DialogDescription>{{ t('fleet.tickets.unlinkBody') }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="unlinkTarget = null">{{ t('common.cancel') }}</Button>
          <Button variant="destructive" :disabled="unlinking" data-testid="ticket-fleet-run-unlink-confirm" @click="confirmUnlink()">{{ t('fleet.tickets.unlink') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
