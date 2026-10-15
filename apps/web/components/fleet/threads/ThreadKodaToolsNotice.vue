<script setup lang="ts">
import { showKodaToolsNotice } from '~/lib/thread-handoff'
import type { ThreadDetailDto } from '~/lib/thread-types'

const props = defineProps<{ thread: ThreadDetailDto }>()
const { t } = useI18n()
</script>

<template>
  <section
    v-if="showKodaToolsNotice(props.thread)"
    class="rounded-md border border-border p-3"
    data-testid="thread-koda-tools-notice"
  >
    <p>{{ t('fleet.threads.kodaTools.unavailable', { runner: props.thread.session!.kodaToolsUnavailableOn }) }}</p>
  </section>
</template>
