<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { buildThreadHandoffSchema, THREAD_HANDOFF_DEFAULTS, toThreadHandoffBody } from '~/lib/thread-handoff-form'
import type { ThreadHandoffBody } from '~/lib/thread-handoff-form'
const props = defineProps<{ open:boolean; command:'PLAN'|'RUN' }>()
const emit = defineEmits<{ (event:'update:open', value:boolean):void; (event:'submit', body:ThreadHandoffBody):void }>()
const { t } = useI18n()
const schema = buildThreadHandoffSchema(t)
const { values, setFieldValue, setFieldError } = useForm({ validationSchema: toTypedSchema(schema), initialValues: { ...THREAD_HANDOFF_DEFAULTS } })
function submit(): void {
  const parsed = schema.safeParse({ ...THREAD_HANDOFF_DEFAULTS, ...values })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue) setFieldError((issue.path[0] === 'profiles' || issue.path[0] === 'bashMode' ? issue.path[0] : 'maxCostUsd'), issue.message)
    return
  }
  emit('submit', toThreadHandoffBody(parsed.data, props.command))
}
</script>
<template>
  <Dialog :open="props.open" @update:open="emit('update:open',$event)">
    <DialogContent v-if="props.open">
      <DialogHeader><DialogTitle>{{ t(props.command === 'PLAN' ? 'fleet.threads.handoff.planDialog.title' : 'fleet.threads.handoff.runDialog.title') }}</DialogTitle></DialogHeader>
      <form @submit.prevent="submit">
        <FormItem><FormLabel>{{ t('fleet.dispatch.profiles') }}</FormLabel><FormControl><FleetTokenListInput :model-value="values.profiles ?? []" @update:model-value="setFieldValue('profiles', $event)" test-id="thread-handoff-profiles" /></FormControl></FormItem>
        <FormItem><FormLabel>{{ t('fleet.dispatch.maxCost') }}</FormLabel><FormControl><Input :model-value="values.maxCostUsd" type="number" data-testid="thread-handoff-max-cost" @update:model-value="setFieldValue('maxCostUsd', Number($event))" /></FormControl><FormMessage>{{ t('fleet.dispatch.validation.maxCost') }}</FormMessage></FormItem>
        <FormItem v-if="props.command === 'RUN'"><FormLabel>{{ t('fleet.bash.modeLabel') }}</FormLabel><FormControl><FleetNativeSelect :model-value="values.bashMode" :options="['raw','gated','escalate'].map(value => ({value,label:t(`fleet.bash.mode.${value}`)}))" testid="thread-handoff-bash-mode" @update:model-value="setFieldValue('bashMode', $event as typeof THREAD_HANDOFF_DEFAULTS.bashMode)" /></FormControl></FormItem>
        <DialogFooter><Button type="button" data-testid="thread-handoff-submit" @click="submit">{{ t('fleet.threads.handoff.actions.submit') }}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
