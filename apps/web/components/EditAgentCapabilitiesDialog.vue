<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('agents.form.editCapabilities') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="capabilities" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('agents.form.capabilities') }}</FormLabel>
            <FormControl>
              <div class="flex flex-wrap gap-2 rounded-md border border-input bg-background p-2 min-h-[42px]">
                <Badge
                  v-for="(cap, index) in capabilitiesTags"
                  :key="index"
                  variant="secondary"
                  class="flex items-center gap-1 px-2 py-0.5"
                >
                  {{ cap }}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    @click="handleRemove(index)"
                    class="ml-0.5 h-4 w-4 p-0"
                  >
                    <LucideX class="h-3 w-3" />
                  </Button>
                </Badge>
                <Input
                  :placeholder="capabilitiesTags.length === 0 ? t('agents.form.capabilitiesPlaceholder') : ''"
                  class="flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground"
                  @keydown.enter.prevent="addCapability"
                />
              </div>
            </FormControl>
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
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { ref, watch } from 'vue'
import { LucideX } from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  agent: {
    slug: string
    capabilities: string[]
  }
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'updated'): void
}>()

const { t } = useI18n()
const toast = useAppToast()

// Tag input state for capabilities
const newCapabilityInput = ref('')
const capabilitiesTags = ref<string[]>([...props.agent.capabilities])

// Watch agent prop to update capabilities when agent changes
watch(() => props.agent.capabilities, (newCapabilities) => {
  capabilitiesTags.value = [...newCapabilities]
}, { deep: true })

const formSchema = toTypedSchema(
  z.object({
    capabilities: z.array(z.string()).default([]),
  })
)

const { handleSubmit, isSubmitting } = useForm({
  validationSchema: formSchema,
})

function addCapability(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.value.trim()
  if (value && !capabilitiesTags.value.includes(value)) {
    capabilitiesTags.value = [...capabilitiesTags.value, value]
    input.value = ''
  }
}

function handleRemove(index: number) {
  capabilitiesTags.value = capabilitiesTags.value.filter((_, i) => i !== index)
}

const { $api } = useApi()

const onSubmit = handleSubmit(async () => {
  try {
    await $api.patch(`/agents/${props.agent.slug}/update-capabilities`, { capabilities: capabilitiesTags.value })
    toast.success(t('agents.toast.capabilitiesUpdated'))
    emit('updated')
    emit('update:open', false)
  } catch (error: unknown) {
    toast.error(t('agents.toast.updateCapabilitiesFailed'))
  }
})
</script>
