<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('memory.retire.title') }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t('memory.retire.item', { itemLabel }) }}</p>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="reason">
          <FormItem>
            <FormLabel>{{ t('memory.retire.reason') }}</FormLabel>
            <FormControl>
              <Textarea
                v-bind="componentField"
                data-testid="memory-retire-reason"
                :placeholder="t('memory.retire.reasonPlaceholder')"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="busy">{{ t('memory.retire.confirm') }}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'

const props = defineProps<{ open: boolean; itemLabel: string; busy: boolean }>()

const emit = defineEmits<{
  (e: 'confirm', reason: string): void
  (e: 'update:open', value: boolean): void
}>()

const { t } = useI18n()
const formSchema = toTypedSchema(z.object({
  reason: z.string().max(500, t('memory.retire.reasonTooLong')),
}))
const { handleSubmit, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { reason: '' },
})

watch(() => props.open, (open) => {
  if (!open) resetForm()
})

const onSubmit = handleSubmit((values) => {
  emit('confirm', values.reason)
})
</script>
