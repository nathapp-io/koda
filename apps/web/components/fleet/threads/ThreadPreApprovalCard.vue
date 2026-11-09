<script setup lang="ts">
import { computed } from 'vue'
import { usd } from '~/lib/fleet-analytics-format'
import type { ThreadDetailDto } from '~/lib/thread-types'

const props = defineProps<{ slug: string; thread: ThreadDetailDto }>()
defineEmits<{ (event: 'changed'): void }>()
const { permissions } = useProjectPermissions(props.slug)
const { t } = useI18n()
const visible = computed(() =>
  props.thread.kind === 'REPO'
  && props.thread.archivedAt === null
  && permissions.value.has('fleet.thread.preapprove'))
</script>

<template>
  <section v-if="visible" class="space-y-2" data-testid="thread-preapproval-card">
    <h2 class="text-lg font-semibold">{{ t('fleet.flows.preapproval.title') }}</h2>
    <template v-if="thread.preApproval">
      <p>{{ t('fleet.flows.preapproval.cap') }}: {{ usd(thread.preApproval.costCapUsd) }}</p>
      <p>{{ t('fleet.flows.preapproval.setAt') }}: {{ new Date(thread.preApproval.at).toLocaleString() }}</p>
      <Button type="button" variant="outline" data-testid="preapproval-clear">
        {{ t('fleet.flows.preapproval.clear') }}
      </Button>
    </template>
    <template v-else>
      <Label for="thread-preapproval-cap">{{ t('fleet.flows.preapproval.cap') }}</Label>
      <Input id="thread-preapproval-cap" type="number" data-testid="preapproval-cap-input" />
      <Button type="button" data-testid="preapproval-set">
        {{ t('fleet.flows.preapproval.set') }}
      </Button>
    </template>
  </section>
</template>
