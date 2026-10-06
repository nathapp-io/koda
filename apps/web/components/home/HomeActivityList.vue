<script setup lang="ts">
import type { HomeActivity } from '~/lib/home-types'

/** Merged ticket/agent/decision events across projects; the API sends raw action codes and the client words the event type. */
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
          <span class="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">{{ event.action }}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{{ event.projectSlug }}</span>
          <FleetAge class="shrink-0 text-xs text-muted-foreground" :iso="event.createdAt" :now="now" mode="ago" />
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
