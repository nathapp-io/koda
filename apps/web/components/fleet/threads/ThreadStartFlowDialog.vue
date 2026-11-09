<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { computed, ref, watch } from 'vue'
import { flowStartRows } from '~/lib/fleet-flow-start'
import { buildFlowStartSchema } from '~/lib/fleet-flow-start-form'
import type { FlowStartRow, FlowStartFormValues } from '~/lib/fleet-flow-start-form'
import { defaultFlowRoles, tickHint } from '~/lib/fleet-flow-start-defaults'
import { toFlowStartBody } from '~/lib/fleet-flow-start-body'

const props = defineProps<{ open: boolean; thread: import('~/lib/thread-types').ThreadDetailDto; viewerId: string }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void; (event: 'submit', body: unknown): void }>()
const { t } = useI18n()
const schema = buildFlowStartSchema(t)
const { setFieldValue, values } = useForm<FlowStartFormValues>({
  validationSchema: toTypedSchema(schema),
  initialValues: { features: [] as FlowStartRow[], roles: { reviewer: '', supervisor: '' }, costCapUsd: 5 },
})
const rows = ref<FlowStartRow[]>([])
const error = ref('')
const hint = computed(() => tickHint(props.thread.preApproval, Number(values.costCapUsd), {
  userId: props.viewerId,
  isThreadCreator: props.thread.createdById === props.viewerId,
}))
function resetRows(): void {
  rows.value = flowStartRows(props.thread).map(row => ({ ...row, dependsOn: [...row.dependsOn] }))
  const roles = defaultFlowRoles(props.thread)
  setFieldValue('features', rows.value)
  setFieldValue('roles', roles)
  setFieldValue('costCapUsd', props.thread.preApproval ? Number(props.thread.preApproval.costCapUsd) : 5)
  error.value = ''
}
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
function changed(): void { error.value = '' }
function submit(): void {
  const result = schema.safeParse({ features: rows.value, roles: values.roles, costCapUsd: values.costCapUsd })
  if (!result.success) { error.value = result.error.issues[0]?.message ?? ''; return }
  error.value = ''
  emit('submit', toFlowStartBody(result.data))
}
function addRow(): void { rows.value.push({ feature: '', specPath: '', dependsOn: [] }) }
</script>
<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent v-if="props.open" data-testid="flow-start-dialog">
      <DialogHeader><DialogTitle>{{ t('fleet.flows.start.title') }}</DialogTitle></DialogHeader>
      <form data-testid="flow-start-form" class="space-y-4" @submit.prevent="submit">
      <div v-for="(row, index) in rows" :key="index" data-testid="flow-start-row" class="space-y-3 rounded-md border border-border p-3">
        <div class="space-y-1"><Label>{{ t('fleet.flows.start.feature') }}</Label><input :value="row.feature" data-testid="flow-start-feature" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" @input="updateFeature(index, ($event.target as HTMLInputElement).value); changed()"></div>
        <div class="space-y-1"><Label>{{ t('fleet.flows.start.specPath') }}</Label><input :value="row.specPath" data-testid="flow-start-spec-path" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" @input="row.specPath = ($event.target as HTMLInputElement).value; changed()"></div>
        <div v-if="index > 0" data-testid="flow-start-dependency-row" :data-feature="row.feature" class="space-y-2">
          <label v-for="earlier in rows.slice(0, index)" :key="earlier.feature" class="flex items-center gap-2 text-sm">
            <input type="checkbox" data-testid="flow-start-dependency" :value="earlier.feature" :checked="row.dependsOn.includes(earlier.feature)" @change="toggleDependency(index, earlier.feature, ($event.target as HTMLInputElement).checked); changed()">
            <span>{{ earlier.feature }}</span>
          </label>
        </div>
        <Button type="button" data-testid="flow-start-remove-row" @click="removeRow(index); changed()">{{ t('fleet.flows.start.removeRow') }}</Button>
      </div>
      <div class="space-y-1"><Label>{{ t('fleet.flows.start.reviewer') }}</Label><input :value="values.roles.reviewer" data-testid="flow-start-reviewer" @input="setFieldValue('roles.reviewer', ($event.target as HTMLInputElement).value); changed()"></div>
      <div class="space-y-1"><Label>{{ t('fleet.flows.start.supervisor') }}</Label><input :value="values.roles.supervisor" data-testid="flow-start-supervisor" @input="setFieldValue('roles.supervisor', ($event.target as HTMLInputElement).value); changed()"></div>
      <div class="space-y-1"><Label>{{ t('fleet.flows.start.costCap') }}</Label><input type="number" :value="values.costCapUsd" data-testid="flow-start-cost-cap" @input="setFieldValue('costCapUsd', ($event.target as HTMLInputElement).value); changed()"></div>
      <p data-testid="flow-start-tick-hint" class="text-sm text-muted-foreground">{{ t(`fleet.flows.start.tick.${hint}`) }}</p>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <Button type="submit" data-testid="flow-start-submit">{{ t('fleet.flows.start.submit') }}</Button>
      <Button type="button" data-testid="flow-start-add-row" @click="addRow(); changed()">{{ t('fleet.flows.start.addRow') }}</Button>
      </form>
    </DialogContent>
  </Dialog>
</template>
