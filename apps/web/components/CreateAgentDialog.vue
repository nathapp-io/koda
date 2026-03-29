<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('agents.form.title') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="name" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('agents.form.name') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('agents.form.namePlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="slug" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('agents.form.slug') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('agents.form.slugPlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

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
                  <button
                    type="button"
                    @click="removeCapability(index)"
                    class="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                  >
                    <LucideX class="h-3 w-3" />
                  </button>
                </Badge>
                <input
                  :placeholder="capabilitiesTags.length === 0 ? t('agents.form.capabilitiesPlaceholder') : ''"
                  class="flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground"
                  @keydown.enter.prevent="addCapability"
                  @keydown.backspace="handleBackspace"
                />
              </div>
              <input type="hidden" v-bind="componentField" :value="capabilitiesTags.join(',')" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="maxConcurrentTickets" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('agents.form.maxConcurrentTickets') }}</FormLabel>
            <FormControl>
              <Input type="number" min="1" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            {{ t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('agents.form.creating') : t('agents.form.create') }}
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
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { t } = useI18n()
const toast = useAppToast()

const availableRoles = ['VERIFIER', 'DEVELOPER', 'REVIEWER'] as const

// Tag input state for capabilities
const capabilitiesInput = ref('')
const capabilitiesTags = ref<string[]>([])

const formSchema = toTypedSchema(
  z.object({
    name: z.string().min(1, t('agents.validation.nameRequired')),
    slug: z.string().min(1, t('agents.validation.slugRequired')).regex(/^[a-z0-9-]+$/, t('agents.validation.slugFormat')),
    roles: z.array(z.string()).min(1, t('agents.validation.rolesRequired')),
    capabilities: z.string().optional(),
    maxConcurrentTickets: z.number().int().min(1).default(3),
  })
)

const { handleSubmit, isSubmitting, resetForm, setFieldValue, values } = useForm({
  validationSchema: formSchema,
  initialValues: {
    name: '',
    slug: '',
    roles: [] as string[],
    capabilities: '',
    maxConcurrentTickets: 3,
  },
})

watch(() => values.name, (name) => {
  if (name !== undefined) {
    setFieldValue('slug', deriveSlug(name))
  }
})

// Sync capabilitiesTags to form field value
watch(capabilitiesTags, (tags) => {
  setFieldValue('capabilities', tags.join(','))
}, { deep: true })

// Clear capabilitiesTags when dialog closes
watch(() => props.open, (isOpen) => {
  if (!isOpen) {
    capabilitiesTags.value = []
  }
})

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

function addCapability(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.value.trim()
  if (value && !capabilitiesTags.value.includes(value)) {
    capabilitiesTags.value.push(value)
    input.value = ''
  }
}

function removeCapability(index: number) {
  capabilitiesTags.value.splice(index, 1)
}

function handleBackspace(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.value && capabilitiesTags.value.length > 0) {
    capabilitiesTags.value.pop()
  }
}

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    await $api.post('/agents', formValues as Record<string, unknown>)
    toast.success(t('agents.toast.created'))
    emit('created')
    emit('update:open', false)
    resetForm()
    capabilitiesTags.value = []
  } catch (error: unknown) {
    toast.error(t('agents.toast.createFailed'))
  }
})
</script>
