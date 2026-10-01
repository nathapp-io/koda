<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[600px]" @interact-outside="guardClose" @escape-key-down="guardClose">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.runners.enrollment.title') }}</DialogTitle>
      </DialogHeader>

      <form v-if="!created" class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="labels">
          <FormItem>
            <FormLabel>{{ t('fleet.runners.enrollment.labels') }}</FormLabel>
            <FormControl><Input v-bind="componentField" placeholder="linux, gpu" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.runners.enrollment.labelsHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="onOpenChange(false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('fleet.runners.enrollment.submitting') : t('fleet.runners.enrollment.submit') }}
          </Button>
        </div>
      </form>

      <div v-else class="space-y-4">
        <p class="text-sm text-muted-foreground">
          {{ t('fleet.runners.enrollment.tokenOnce', { expiresAt: new Date(created.expiresAt).toLocaleString() }) }}
        </p>
        <div class="space-y-1">
          <Label>{{ t('fleet.runners.enrollment.token') }}</Label>
          <div class="flex gap-2">
            <Input :value="created.token" readonly class="flex-1 font-mono text-sm" data-testid="enrollment-token" @focus="selectAll" />
            <Button type="button" variant="outline" @click="copy(created.token, 'token')">{{ copied === 'token' ? t('fleet.common.copied') : t('fleet.common.copy') }}</Button>
          </div>
        </div>
        <div class="space-y-1">
          <Label>{{ t('fleet.runners.enrollment.command') }}</Label>
          <div class="flex gap-2">
            <pre class="flex-1 select-all overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono text-xs">{{ command }}</pre>
            <Button type="button" variant="outline" @click="copy(command, 'command')">{{ copied === 'command' ? t('fleet.common.copied') : t('fleet.common.copy') }}</Button>
          </div>
          <p class="text-xs text-muted-foreground">{{ t('fleet.runners.enrollment.commandHint') }}</p>
        </div>
        <div class="flex justify-end">
          <Button type="button" @click="onOpenChange(false)">{{ t('common.done') }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { parseLabels } from '~/lib/fleet-validation'
import { enrollCommand } from '~/lib/fleet-enroll'
import type { FleetEnrollmentCreated } from '~/lib/fleet-types'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const { t } = useI18n()
const toast = useAppToast()
const { createEnrollment } = useFleetRunners()

const created = ref<FleetEnrollmentCreated | null>(null)
const copied = ref<'token' | 'command' | null>(null)
// Bumped on every close: a token request that answers after the dialog closed must not
// reappear when it is opened again.
let generation = 0

const formSchema = toTypedSchema(z.object({
  labels: z.string().superRefine((value, ctx) => {
    const parsed = parseLabels(value)
    if (parsed.ok) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: parsed.error === 'tooMany' ? t('fleet.validation.labelsTooMany') : t('fleet.validation.labelInvalid', { label: parsed.label }),
    })
  }),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({ validationSchema: formSchema, initialValues: { labels: '' } })

const command = computed(() => (created.value ? enrollCommand(window.location.origin, created.value.token) : ''))

const onSubmit = handleSubmit(async (values) => {
  const parsed = parseLabels(values.labels)
  if (!parsed.ok) return
  const started = generation
  try {
    const result = await createEnrollment(parsed.labels)
    if (started !== generation) return
    created.value = result
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})

/** navigator.clipboard is undefined on a plain-http origin (the VPN phase): say so, the text stays selectable. */
async function copy(text: string, which: 'token' | 'command'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = which
  } catch {
    toast.error(t('fleet.common.copyFailed'))
  }
}

function selectAll(event: FocusEvent): void {
  (event.target as HTMLInputElement | null)?.select()
}

/** While a token is showing, only Done closes the dialog: Esc or an outside click would lose it. */
function guardClose(event: Event): void {
  if (created.value) event.preventDefault()
}

/** Closing forgets the token: it is shown once (S1 spec §11). */
function onOpenChange(value: boolean): void {
  if (!value) {
    generation += 1
    created.value = null
    copied.value = null
    resetForm()
  }
  emit('update:open', value)
}
</script>
