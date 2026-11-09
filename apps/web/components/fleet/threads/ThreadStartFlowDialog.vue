<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { ref, watch } from 'vue'
import { flowStartRows } from '~/lib/fleet-flow-start'
import { buildFlowStartSchema } from '~/lib/fleet-flow-start-form'
import type { FlowStartRow } from '~/lib/fleet-flow-start'

const props = defineProps<{ open: boolean; thread: import('~/lib/thread-types').ThreadDetailDto; viewerId: string }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void; (event: 'submit', body: unknown): void }>()
const { t } = useI18n()
const schema = buildFlowStartSchema(t)
const { values, setFieldValue } = useForm({
  validationSchema: toTypedSchema(schema),
  initialValues: { features: [] as FlowStartRow[], roles: { reviewer: '', supervisor: '' }, costCapUsd: 5 },
})
const rows = ref<FlowStartRow[]>([])
function resetRows(): void { rows.value = flowStartRows(props.thread).map(row => ({ ...row, dependsOn: [...row.dependsOn] })) }
watch(() => props.open, open => { if (open) resetRows() }, { immediate: true })
function updateFeature(index: number, feature: string): void {
  const previous = rows.value[index]?.feature
  if (previous !== undefined) {
    for (const row of rows.value.slice(index + 1)) row.dependsOn = row.dependsOn.map(dep => dep === previous ? feature : dep)
  }
  const row = rows.value[index]
  if (row !== undefined) row.feature = feature
}
function toggleDependency(index: number, feature: string, checked: boolean): void {
  const row = rows.value[index]
  if (!row) return
  row.dependsOn = checked ? [...row.dependsOn, feature] : row.dependsOn.filter(dep => dep !== feature)
}
function removeRow(index: number): void {
  const removed = rows.value[index]
  if (!removed) return
  rows.value.splice(index, 1)
  for (const row of rows.value.slice(index)) row.dependsOn = row.dependsOn.filter(dep => dep !== removed.feature)
}
function syncRows(): void { setFieldValue('features', rows.value.map(row => ({ ...row, dependsOn: [...row.dependsOn] }))) }
watch(rows, syncRows, { deep: true })
function addRow(): void { rows.value.push({ feature: '', specPath: '', dependsOn: [] }) }
</script>
<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent v-if="props.open" data-testid="flow-start-dialog">
      <DialogHeader><DialogTitle>{{ t('fleet.flows.start.title') }}</DialogTitle></DialogHeader>
      <div v-for="(row, index) in rows" :key="index" data-testid="flow-start-row" class="space-y-3 rounded-md border border-border p-3">
        <div class="space-y-1"><Label>{{ t('fleet.flows.start.feature') }}</Label><Input :model-value="row.feature" data-testid="flow-start-feature" @update:model-value="updateFeature(index, String($event))" /></div>
        <div class="space-y-1"><Label>{{ t('fleet.flows.start.specPath') }}</Label><Input :model-value="row.specPath" data-testid="flow-start-spec-path" @update:model-value="row.specPath = String($event)" /></div>
        <div v-if="index > 0" class="space-y-2">
          <label v-for="earlier in rows.slice(0, index)" :key="earlier.feature" class="flex items-center gap-2 text-sm">
            <input type="checkbox" data-testid="flow-start-dependency" :value="earlier.feature" :checked="row.dependsOn.includes(earlier.feature)" @change="toggleDependency(index, earlier.feature, ($event.target as HTMLInputElement).checked)">
            <span>{{ earlier.feature }}</span>
          </label>
        </div>
        <Button type="button" data-testid="flow-start-remove-row" @click="removeRow(index)">{{ t('fleet.flows.start.removeRow') }}</Button>
      </div>
      <Button type="button" data-testid="flow-start-add-row" @click="addRow">{{ t('fleet.flows.start.addRow') }}</Button>
    </DialogContent>
  </Dialog>
</template>
