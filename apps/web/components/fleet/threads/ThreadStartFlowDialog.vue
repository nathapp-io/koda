<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { computed, ref, watch } from 'vue'
import { flowStartRows } from '~/lib/fleet-flow-start'
import { buildFlowStartSchema, firstFlowStartIssue, FLOW_COST_CAP_MAX_USD, FLOW_COST_CAP_MIN_USD, FLOW_COST_CAP_STEP_USD } from '~/lib/fleet-flow-start-form'
import type { FlowStartRow, FlowStartFormValues } from '~/lib/fleet-flow-start-form'
import { defaultFlowRoles, tickHint } from '~/lib/fleet-flow-start-defaults'
import { toFlowStartBody } from '~/lib/fleet-flow-start-body'

/**
 * One editable row. Dependencies hold a row id, never a feature name: a name is text the user
 * retypes, so renaming `a` to `b2` passes through `b` and a name-keyed rewrite would retarget every
 * later row that depends on `b`. Names are produced only when the form is serialized for submit.
 */
interface EditRow { id: number; feature: string; specPath: string; dependsOn: number[] }

const props = defineProps<{ open: boolean; thread: import('~/lib/thread-types').ThreadDetailDto; viewerId: string }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void; (event: 'submit', body: unknown): void }>()
const { t } = useI18n()
const COST_CAP_MIN = FLOW_COST_CAP_MIN_USD
const COST_CAP_MAX = FLOW_COST_CAP_MAX_USD
const COST_CAP_STEP = FLOW_COST_CAP_STEP_USD
const schema = buildFlowStartSchema(t)
const { setFieldValue, values } = useForm<FlowStartFormValues>({
  validationSchema: toTypedSchema(schema),
  initialValues: { features: [] as FlowStartRow[], roles: { reviewer: '', supervisor: '' }, costCapUsd: 5 },
})
const rows = ref<EditRow[]>([])
let nextRowId = 1
const error = ref('')
const hint = computed(() => tickHint(props.thread.preApproval, Number(values.costCapUsd), {
  userId: props.viewerId,
  isThreadCreator: props.thread.createdById === props.viewerId,
}))
function resetRows(): void {
  const idByName = new Map<string, number>()
  rows.value = flowStartRows(props.thread).map(row => {
    const id = nextRowId++
    const dependsOn = row.dependsOn
      .map(name => idByName.get(name))
      .filter((dep): dep is number => dep !== undefined)
    if (!idByName.has(row.feature)) idByName.set(row.feature, id)
    return { id, feature: row.feature, specPath: row.specPath, dependsOn }
  })
  const roles = defaultFlowRoles(props.thread)
  setFieldValue('features', serializeRows())
  setFieldValue('roles', roles)
  setFieldValue('costCapUsd', props.thread.preApproval ? Number(props.thread.preApproval.costCapUsd) : 5)
  error.value = ''
}
watch(() => props.open, open => { if (open) resetRows() }, { immediate: true })
/** Rows as the schema and the API see them: names, in row order, dependencies naming earlier rows. */
function serializeRows(): FlowStartRow[] {
  const indexById = new Map(rows.value.map((row, index) => [row.id, index]))
  return rows.value.map((row, index) => {
    const dependsOn: string[] = []
    for (const id of row.dependsOn) {
      const at = indexById.get(id)
      if (at === undefined || at >= index) continue
      dependsOn.push(rows.value[at]?.feature ?? '')
    }
    return { feature: row.feature, specPath: row.specPath, dependsOn }
  })
}
function toggleDependency(index: number, id: number, checked: boolean): void {
  const row = rows.value[index]
  if (!row) return
  row.dependsOn = checked ? [...row.dependsOn, id] : row.dependsOn.filter(dep => dep !== id)
}
function removeRow(index: number): void {
  const [removed] = rows.value.splice(index, 1)
  if (!removed) return
  for (const row of rows.value) row.dependsOn = row.dependsOn.filter(dep => dep !== removed.id)
}
function syncRows(): void { setFieldValue('features', serializeRows()) }
watch(rows, syncRows, { deep: true })
function changed(): void { error.value = '' }
function submit(): void {
  const result = schema.safeParse({ features: serializeRows(), roles: values.roles, costCapUsd: values.costCapUsd })
  if (!result.success) { error.value = firstFlowStartIssue(result.error.issues)?.message ?? ''; return }
  error.value = ''
  emit('submit', toFlowStartBody(result.data))
}
function addRow(): void { rows.value.push({ id: nextRowId++, feature: '', specPath: '', dependsOn: [] }) }
</script>
<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent v-if="props.open" data-testid="flow-start-dialog" class="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>{{ t('fleet.flows.start.title') }}</DialogTitle></DialogHeader>
      <form data-testid="flow-start-form" class="space-y-4" @submit.prevent="submit">
      <div v-for="(row, index) in rows" :key="row.id" data-testid="flow-start-row" class="space-y-3 rounded-md border border-border p-3">
        <div class="space-y-1"><Label :for="`flow-start-feature-${index}`">{{ t('fleet.flows.start.feature') }}</Label><input :id="`flow-start-feature-${index}`" :value="row.feature" data-testid="flow-start-feature" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" @input="row.feature = ($event.target as HTMLInputElement).value; changed()"></div>
        <div class="space-y-1"><Label :for="`flow-start-spec-path-${index}`">{{ t('fleet.flows.start.specPath') }}</Label><input :id="`flow-start-spec-path-${index}`" :value="row.specPath" data-testid="flow-start-spec-path" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" @input="row.specPath = ($event.target as HTMLInputElement).value; changed()"></div>
        <div v-if="index > 0" data-testid="flow-start-dependency-row" :data-feature="row.feature" class="space-y-2">
          <label v-for="earlier in rows.slice(0, index)" :key="earlier.id" class="flex items-center gap-2 text-sm">
            <input type="checkbox" data-testid="flow-start-dependency" :value="earlier.feature" :checked="row.dependsOn.includes(earlier.id)" @change="toggleDependency(index, earlier.id, ($event.target as HTMLInputElement).checked); changed()">
            <span>{{ earlier.feature }}</span>
          </label>
        </div>
        <Button type="button" data-testid="flow-start-remove-row" @click="removeRow(index); changed()">{{ t('fleet.flows.start.removeRow') }}</Button>
      </div>
      <div class="space-y-1"><Label for="flow-start-reviewer">{{ t('fleet.flows.start.reviewer') }}</Label><Input id="flow-start-reviewer" :value="values.roles.reviewer" data-testid="flow-start-reviewer" @input="setFieldValue('roles.reviewer', ($event.target as HTMLInputElement).value); changed()" /></div>
      <div class="space-y-1"><Label for="flow-start-supervisor">{{ t('fleet.flows.start.supervisor') }}</Label><Input id="flow-start-supervisor" :value="values.roles.supervisor" data-testid="flow-start-supervisor" @input="setFieldValue('roles.supervisor', ($event.target as HTMLInputElement).value); changed()" /></div>
      <div class="space-y-1"><Label for="flow-start-cost-cap">{{ t('fleet.flows.start.costCap') }}</Label><Input id="flow-start-cost-cap" type="number" :min="COST_CAP_MIN" :max="COST_CAP_MAX" :step="COST_CAP_STEP" :value="values.costCapUsd" data-testid="flow-start-cost-cap" @input="setFieldValue('costCapUsd', ($event.target as HTMLInputElement).value); changed()" /></div>
      <p data-testid="flow-start-tick-hint" class="text-sm text-muted-foreground">{{ t(`fleet.flows.start.tick.${hint}`) }}</p>
      <p v-if="error" role="alert" class="text-sm text-status-rejected">{{ error }}</p>
      <Button type="submit" data-testid="flow-start-submit">{{ t('fleet.flows.start.submit') }}</Button>
      <Button type="button" data-testid="flow-start-add-row" @click="addRow(); changed()">{{ t('fleet.flows.start.addRow') }}</Button>
      </form>
    </DialogContent>
  </Dialog>
</template>
