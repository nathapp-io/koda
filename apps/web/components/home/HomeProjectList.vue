<script setup lang="ts">
import type { HomeProject } from '~/lib/home-types'

/** Compact project rows: name + key, one-line description, open/attention counts (MASTER-PLAN §6 slice 2). */
defineProps<{ projects: HomeProject[] }>()

const { t } = useI18n()
</script>

<template>
  <Card class="shadow-none">
    <CardContent class="p-0">
      <ul class="divide-y divide-border">
        <li v-for="project in projects" :key="project.id">
          <NuxtLink :to="`/${project.slug}`" class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/40" :data-testid="`home-project-${project.slug}`">
            <span class="shrink-0 font-medium">{{ project.name }}</span>
            <Badge variant="outline" class="font-mono text-[11px]">{{ project.key }}</Badge>
            <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ project.description }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ t('home.projects.open', { n: project.openTickets }) }}</span>
            <span
              v-if="project.attentionJobs > 0"
              class="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive"
            >{{ t('home.projects.attention', { n: project.attentionJobs }) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
