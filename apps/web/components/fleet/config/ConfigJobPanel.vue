<script setup lang="ts">
import { computed } from 'vue'
import { safePrUrl } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto; slug: string; canWork: boolean }>()
const emit = defineEmits<{ (e: 'regenerate'): void }>()
const { t } = useI18n()

const config = computed(() => props.job.configEdit ?? null)
const result = computed(() => config.value?.result ?? null)
const outcome = computed(() => result.value?.outcome ?? null)
const prUrl = computed(() => safePrUrl(props.job.resultPrUrl))
const resultFiles = computed(() => result.value?.files ?? [])
const canReopen = computed(() => props.canWork && config.value?.mode === 'edit' && (outcome.value === 'conflict' || outcome.value === 'invalid'))
const canRegenerate = computed(() => props.canWork && outcome.value === 'drift' && resultFiles.value.length > 0)
const reopenHref = computed(() => `/${props.slug}/fleet/repos/${props.job.repoId}/config?reopen=${encodeURIComponent(props.job.id)}`)
/** Which list the result files are: conflict files, drifted files, or what the PR committed. */
const filesLabel = computed(() => (outcome.value === 'conflict' || outcome.value === 'drift' || outcome.value === 'ok' ? t(`fleet.config.panel.files.${outcome.value}`) : null))
</script>

<template>
  <section v-if="config" class="space-y-3 rounded-md border border-border p-4 text-sm" data-testid="fleet-config-panel">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-medium">{{ t(`fleet.config.panel.mode.${config.mode}`) }}</span>
      <span v-if="config.prTitle" class="text-muted-foreground">· {{ config.prTitle }}</span>
      <Badge v-if="outcome" :variant="job.state === 'FAILED' ? 'destructive' : 'outline'" data-testid="config-panel-outcome" :data-outcome="outcome">
        {{ t(`fleet.config.panel.outcome.${outcome}`) }}
      </Badge>
      <span v-else class="text-muted-foreground">{{ t('fleet.config.panel.pending') }}</span>
    </div>

    <div v-if="config.files.length > 0">
      <p class="text-muted-foreground">{{ t('fleet.config.panel.edited') }}</p>
      <ul class="mt-1 space-y-0.5 font-mono text-xs">
        <li v-for="file in config.files" :key="file" data-testid="config-panel-file">{{ file }}</li>
      </ul>
    </div>

    <p v-if="prUrl">
      <a :href="prUrl" target="_blank" rel="noopener noreferrer" class="break-all text-primary underline-offset-4 hover:underline" data-testid="config-panel-pr">{{ prUrl }}</a>
    </p>

    <div v-if="filesLabel && resultFiles.length > 0">
      <p class="text-muted-foreground">{{ filesLabel }}</p>
      <ul class="mt-1 space-y-0.5 font-mono text-xs">
        <li v-for="file in resultFiles" :key="file" data-testid="config-panel-result-file">{{ file }}</li>
      </ul>
    </div>
    <p v-if="outcome === 'drift' && resultFiles.length === 0" class="text-muted-foreground">{{ t('fleet.config.panel.noDrift') }}</p>

    <pre v-if="result?.output" class="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs" data-testid="config-panel-output">{{ result.output }}</pre>

    <div class="flex flex-wrap gap-2">
      <NuxtLink v-if="canReopen" :to="reopenHref" class="inline-flex h-9 items-center rounded-md border border-input px-3 hover:bg-muted" data-testid="config-panel-reopen">
        {{ t('fleet.config.panel.reopen') }}
      </NuxtLink>
      <Button v-if="canRegenerate" size="sm" data-testid="config-panel-regenerate" @click="emit('regenerate')">{{ t('fleet.config.panel.regenerate') }}</Button>
    </div>
  </section>
</template>
