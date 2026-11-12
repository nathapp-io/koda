<script setup lang="ts">
import type { HomeActivity } from '~/lib/home-types'
import { humanizeCode } from '~/lib/humanize-code'

/**
 * Merged ticket/agent/decision events across projects. The API sends raw action codes: the client words the event
 * type, shows the action as readable words and keeps the raw code as the tooltip.
 */
defineProps<{ activity: HomeActivity[]; now: Date }>()

const { t } = useI18n()
</script>

<template>
  <Card class="shadow-none">
    <CardContent class="p-0">
      <p v-if="activity.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">{{ t('home.activity.empty') }}</p>
      <ul v-else class="divide-y divide-border">
        <li v-for="event in activity" :key="event.id" class="flex items-center gap-2 px-4 py-2 text-sm" :data-testid="`home-activity-${event.eventType}`">
          <span class="w-16 shrink-0 text-xs text-muted-foreground">{{ t(`home.activity.eventType.${event.eventType}`) }}</span>
          <span class="truncate font-medium" :title="event.action">{{ humanizeCode(event.action) }}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{{ event.projectSlug }}</span>
          <FleetAge class="shrink-0 text-xs text-muted-foreground" :iso="event.createdAt" :now="now" mode="ago" />
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
