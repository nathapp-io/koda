<script setup lang="ts">
import { showProjectCodeNotice } from '~/lib/thread-handoff'
import type { ThreadDetailDto } from '~/lib/thread-types'

const props = defineProps<{ thread: ThreadDetailDto }>()
const { t } = useI18n()
</script>

<template>
  <section
    v-if="showProjectCodeNotice(props.thread)"
    class="rounded-md border border-border p-3"
    data-testid="thread-project-code-notice"
  >
    <p>{{ t('fleet.threads.projectCode.unavailable', { runner: props.thread.session!.projectCodeUnavailableOn }) }}</p>
  </section>
</template>
