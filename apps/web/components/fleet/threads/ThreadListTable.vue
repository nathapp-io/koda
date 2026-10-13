<script setup lang="ts">
import { costText, sessionLabel } from '~/lib/thread-view'
import { timeText } from '~/lib/fleet-analytics-format'
import type { ThreadDto } from '~/lib/thread-types'

function activityText(value: string | null | undefined): string {
  return value && Number.isFinite(new Date(value).getTime()) ? timeText(value) : '-'
}

defineProps<{
  threads: ThreadDto[]
  status: 'ACTIVE' | 'ARCHIVED'
  nameOf: (userId: string) => string | null
  slug: string
}>()

const { t } = useI18n()
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
            <NuxtLink :to="`/${slug}/threads/${thread.id}`" class="text-primary hover:underline">{{ thread.title }}</NuxtLink>
          </td>
          <td class="px-3 py-2 text-muted-foreground">{{ nameOf(thread.createdById) ?? thread.createdById }}</td>
          <td class="px-3 py-2 font-mono text-xs">feat/{{ thread.feature }}</td>
          <td class="px-3 py-2">{{ thread.backend.kind }}<span v-if="thread.backend.model"> · {{ thread.backend.model }}</span></td>
          <td class="px-3 py-2"><span class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ t(`fleet.threads.session.${sessionLabel(thread)}`) }}</span></td>
          <td class="px-3 py-2 text-muted-foreground">{{ activityText(thread.lastActivityAt) }}</td>
          <td class="px-3 py-2 text-right font-mono text-xs">{{ costText(thread) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
