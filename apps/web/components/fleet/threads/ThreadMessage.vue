<script setup lang="ts">
import type { ChatMessageDto } from '~/lib/thread-types'
import { renderThreadMarkdown } from '~/lib/thread-markdown'
import FleetThreadsThreadToolChip from '~/components/fleet/threads/ThreadToolChip.vue'

/**
 * Fleet S5a §4.62 (US-006): one transcript row.
 *
 * B4-D1: an assistant `content` is the ONE runner/agent string rendered as HTML, through
 * `renderThreadMarkdown` (sanitized, images removed, koda ticket/job paths linked). Everything
 * else — user messages, `errorReason`, tool text — stays `{{ }}` interpolation only, never `v-html`.
 *
 * fleet S5b (US-006): the project `slug` is what turns `/<slug>/tickets/<ref>` and
 * `/<slug>/fleet/jobs/<id>` inside that content into links.
 */
const TERMINAL_STATUSES: readonly string[] = ['errored', 'cancelled', 'timed_out', 'interrupted']

const props = defineProps<{ message: ChatMessageDto; slug?: string }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="props.message.role === 'system'" class="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground" data-testid="thread-system-note">
    <div class="font-medium">{{ t('fleet.threads.message.system') }}</div>
    <div class="mt-1 whitespace-pre-wrap break-words">{{ props.message.content }}</div>
  </div>
  <div v-else class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-message">
    <div
      v-if="props.message.role === 'assistant' && props.message.content"
      class="whitespace-pre-wrap break-words"
      v-html="renderThreadMarkdown(props.message.content, props.slug)"
    />
    <div v-else class="whitespace-pre-wrap break-words">{{ props.message.content }}</div>

    <div v-if="props.message.status === 'streaming'" class="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="thread-streaming">
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
      <span>{{ t('fleet.threads.detail.streaming') }}</span>
    </div>

    <div
      v-if="TERMINAL_STATUSES.includes(props.message.status)"
      class="mt-1 text-xs text-muted-foreground"
      data-testid="thread-terminal"
    >
      {{ t(`fleet.threads.detail.status.${props.message.status}`) }}<span v-if="props.message.errorReason"> — {{ props.message.errorReason }}</span>
    </div>

    <div v-if="props.message.toolSummary && props.message.toolSummary.length > 0" class="mt-1 flex flex-wrap gap-1.5">
      <FleetThreadsThreadToolChip
        v-for="entry in props.message.toolSummary"
        :key="entry.callId"
        :entry="entry"
        :message-status="props.message.status"
      />
    </div>
  </div>
</template>