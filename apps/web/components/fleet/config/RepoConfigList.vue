<script setup lang="ts">
import { computed } from 'vue'
import type { FleetRepo } from '~/lib/fleet-types'

const props = defineProps<{ slug: string; repos: FleetRepo[] }>()
const { t } = useI18n()

const sorted = computed(() => props.repos.slice().sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`)))
</script>

<template>
  <section v-if="sorted.length > 0" class="rounded-md border border-border p-4" data-testid="fleet-repo-config-card">
    <h2 class="text-sm font-medium">{{ t('fleet.config.repos.title') }}</h2>
    <ul class="mt-2 divide-y divide-border">
      <li v-for="repo in sorted" :key="repo.id" class="flex items-center justify-between gap-3 py-2 text-sm">
        <span class="truncate">{{ repo.owner }}/{{ repo.name }} <span class="text-muted-foreground">@ {{ repo.defaultBranch }}</span></span>
        <NuxtLink :to="`/${slug}/fleet/repos/${repo.id}/config`" class="shrink-0 text-primary underline-offset-4 hover:underline" data-testid="fleet-repo-config-link">
          {{ t('fleet.config.repos.open') }}
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
