<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('agents.form.editRoles') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="roles" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('agents.form.roles') }}</FormLabel>
            <div class="flex flex-col gap-2">
              <label v-for="role in availableRoles" :key="role" class="flex items-center gap-2">
                <input
                  type="checkbox"
                  :value="role"
                  :checked="((Array.isArray(componentField.modelValue) ? componentField.modelValue : []) as string[]).indexOf(role as string) !== -1"
                  @change="(e) => {
                    const target = e.target as HTMLInputElement
                    const currentValues = Array.isArray(componentField.modelValue) ? componentField.modelValue : []
                    if (target.checked) {
                      componentField['onUpdate:modelValue']([...currentValues, role])
                    } else {
                      componentField['onUpdate:modelValue'](currentValues.filter((v: string) => v !== role))
                    }
                  }"
                  class="h-4 w-4 rounded border-border"
                />
                <span class="text-sm">{{ role }}</span>
              </label>
            </div>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            {{ t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('agents.form.saving') : t('agents.form.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee/validate/zod'
import * as z from 'zod'

const props = defineProps<{
  open: boolean
  agent: {
    slug: string
    roles: string[]
  }
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'updated'): void
}>()

const { t } = useI18n()
const toast = useAppToast()

const availableRoles = ['VERIFIER', 'DEVELOPER', 'REVIEWER'] as const

const formSchema = toTypedSchema(
  z.object({
    roles: z.array(z.string()).min(1, t('agents.validation.rolesRequired')),
  })
)

const { handleSubmit, isSubmitting, setFieldValue } = useForm({
  validationSchema: formSchema,
  initialValues: {
    roles: props.agent.roles as string[],
  },
})

// Set initial values when agent changes
setFieldValue('roles', props.agent.roles as string[])

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    await $api.patch(`/agents/${props.agent.slug}/update-roles`, { roles: formValues.roles })
    toast.success(t('agents.toast.rolesUpdated'))
    emit('updated')
    emit('update:open', false)
  } catch (error: unknown) {
    toast.error(t('agents.toast.updateRolesFailed'))
  }
})
</script>
