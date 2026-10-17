<script setup lang="ts">
import { costText, sessionLabel } from '~/lib/thread-view'
import { timeText } from '~/lib/fleet-analytics-format'
import type { ThreadDto } from '~/lib/thread-types'

function activityText(value: string | null | undefined): string {
  return value && Number.isFinite(new Date(value).getTime()) ? timeText(value) : '-'
}

const props = defineProps<{
  threads: ThreadDto[]
  status: 'ACTIVE' | 'ARCHIVED'
  nameOf: (userId: string) => string | null
  /** The project whose threads these are; required unless `basePath` supplies the row-link prefix. */
  slug?: string
  /** The row-link prefix on the personal list (`/threads`); defaults to `/<slug>/threads` (S5b 1d). */
  basePath?: string
}>()

const { t } = useI18n()

/**
 * The prefix every row link starts with: `basePath` when given, else the project path (S5b 1d). Both props are
 * optional because a project table passes only `slug` and the personal list only `basePath`, so a caller that passes
 * neither gets the personal `/threads` links rather than the broken `//threads/<id>` (M3).
 */
const rowBase = computed(() => {
  if (props.basePath) return props.basePath
  return props.slug ? `/${props.slug}/threads` : '/threads'
})

/**
 * What the feature column shows for one row: a PROJECT thread shows its scope label and a
 * WORKSPACE thread shows its home project (it has no feature at all); a REPO thread shows
 * `feat/<feature>`.
 */
function featureLabel(thread: ThreadDto): string {
  if (thread.kind === 'PROJECT') return t('fleet.threads.kind.project')
  if (thread.kind === 'WORKSPACE') return thread.homeProject?.name ?? t('fleet.threads.kind.workspace')
  return `feat/${thread.feature}`
}
</script>

<template>
  <div v-if="threads.length === 0" class="rounded-md border border-border px-4 py-10 text-center text-sm text-muted-foreground">
    {{ t(status === 'ARCHIVED' ? 'fleet.threads.list.emptyArchived' : 'fleet.threads.list.emptyActive') }}
  </div>
  <div v-else class="overflow-x-auto rounded-md border border-border">
    <table class="w-full text-left text-sm">
      <thead class="border-b border-border bg-muted/50 text-xs text-muted-foreground">
        <tr>
          <th class="px-3 py-2 font-medium">{{ t('fleet.threads.list.title') }}</th>
          <th class="px-3 py-2 font-medium">{{ t('fleet.threads.list.creator') }}</th>
          <th class="px-3 py-2 font-medium">{{ t('fleet.threads.list.feature') }}</th>
          <th class="px-3 py-2 font-medium">{{ t('fleet.threads.list.backend') }}</th>
          <th class="px-3 py-2 font-medium">{{ t('fleet.threads.list.session') }}</th>
          <th class="px-3 py-2 font-medium">{{ t('fleet.threads.list.lastActivity') }}</th>
          <th class="px-3 py-2 text-right font-medium">{{ t('fleet.threads.list.cost') }}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        <tr v-for="thread in threads" :key="thread.id" class="hover:bg-muted/30">
          <td class="px-3 py-2 font-medium">
            <NuxtLink :to="`${rowBase}/${thread.id}`" class="text-primary hover:underline">{{ thread.title }}</NuxtLink>
          </td>
          <td class="px-3 py-2 text-muted-foreground">{{ nameOf(thread.createdById) ?? thread.createdById }}</td>
          <td class="px-3 py-2 font-mono text-xs">{{ featureLabel(thread) }}</td>
          <td class="px-3 py-2">{{ thread.backend.kind }}<span v-if="thread.backend.model"> · {{ thread.backend.model }}</span></td>
          <td class="px-3 py-2"><span class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ t(`fleet.threads.session.${sessionLabel(thread)}`) }}</span></td>
          <td class="px-3 py-2 text-muted-foreground">{{ activityText(thread.lastActivityAt) }}</td>
          <td class="px-3 py-2 text-right font-mono text-xs">{{ costText(thread) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
