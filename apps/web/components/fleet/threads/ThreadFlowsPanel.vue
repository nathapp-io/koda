<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useFleetFlows } from '~/composables/useFleetFlows'
import { flowStateKey, type FleetFlowDto } from '~/lib/fleet-flows'
const props = defineProps<{ slug: string; threadId: string }>()
const { permissions } = useProjectPermissions(props.slug)
const flows = useFleetFlows(props.slug)
const records = ref<FleetFlowDto[]>([])
const { t } = useI18n()
// Permissions may hydrate after mount; the watch allows that late grant without issuing an unfiltered read.
let stop = (): void => undefined
const fetchThreadFlows = (): void => {
  stop()
  void flows.list(1, props.threadId).then(page => { records.value = page.records }).catch(() => { records.value = [] })
}
stop = watch(() => permissions.value.has('fleet.flow.read'), (allowed) => {
  if (allowed) fetchThreadFlows()
})
onMounted(() => { if (permissions.value.has('fleet.flow.read')) fetchThreadFlows() })
</script>
<template>
  <section v-if="records.length" class="space-y-2" data-testid="thread-flows-panel">
    <h2 class="text-sm font-medium">{{ t('fleet.flows.panel.title') }}</h2>
    <ul><li v-for="flow in records" :key="flow.id"><NuxtLink :to="`/${slug}/flows/${flow.id}`">{{ flowStateKey(flow.state) ? t(flowStateKey(flow.state)!) : flow.state }}</NuxtLink></li></ul>
  </section>
</template>
