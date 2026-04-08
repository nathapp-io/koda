<script setup lang="ts">
definePageMeta({ layout: 'default' })

import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { normalizeHexColor } from '~/lib/utils'

const fallbackColor = '#E5E7EB'

const VALID_HEX_REGEX = /^#[0-9A-F]{6}$/
const isValidColor = (color: string): boolean => VALID_HEX_REGEX.test(color)

interface Label {
  id: string
  name: string
  color: string
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const { data: labelsData, pending, error, refresh } = useAsyncData(
  `labels-${slug}`,
  () => $api.get(`/projects/${slug}/labels`) as Promise<Label[]>,
)

const labels = computed(() => labelsData.value ?? [])
const editingId = ref<string | null>(null)
const editName = ref('')
const editColor = ref('#6366F1')

const formSchema = toTypedSchema(z.object({
  name: z.string().min(1, 'Name is required'),
  color: z.string().regex(/^#[0-9A-F]{6}$/, t('labels.validation.colorInvalid')),
}))

const { handleSubmit, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { name: '', color: '#6366F1' },
})

const onSubmit = handleSubmit(async (values) => {
  try {
    await $api.post(`/projects/${slug}/labels`, {
      name: values.name,
      color: normalizeHexColor(values.color || '#6366F1'),
    })
    toast.success(t('labels.toast.created'))
    resetForm()
    await refresh()
  } catch (err) {
    toast.error(extractApiError(err))
  }
})

async function deleteLabel(labelId: string) {
  try {
    await $api.delete(`/projects/${slug}/labels/${labelId}`)
    toast.success(t('labels.toast.deleted'))
    await refresh()
  } catch (err) {
    toast.error(extractApiError(err))
  }
}

function startEdit(label: Label) {
  editingId.value = label.id
  editName.value = label.name
  editColor.value = normalizeHexColor(label.color || '#6366F1')
}

function cancelEdit() {
  editingId.value = null
  editName.value = ''
  editColor.value = '#6366F1'
}

async function saveEdit(label: Label) {
  const nextName = editName.value.trim()
  const nextColor = normalizeHexColor(editColor.value || '#6366F1')
  if (!nextName) {
    toast.error(t('labels.validation.nameRequired'))
    return
  }

  const payload: Record<string, unknown> = {}
  if (nextName !== label.name) payload.name = nextName
  if (nextColor !== normalizeHexColor(label.color || '#6366F1')) payload.color = nextColor
  if (Object.keys(payload).length === 0) {
    toast.success(t('labels.toast.noChanges'))
    cancelEdit()
    return
  }

  try {
    await $api.patch(`/projects/${slug}/labels/${label.id}`, payload)
    toast.success(t('labels.toast.updated'))
    cancelEdit()
    await refresh()
  } catch (err) {
    toast.error(extractApiError(err))
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('labels.title')" />

    <!-- Create Label Form -->
    <div class="rounded-md border border-border p-4 space-y-4">
      <h2 class="text-lg font-semibold">{{ t('labels.form.create') }}</h2>
      <form @submit="onSubmit" class="flex items-end gap-4">
        <FormField name="name" v-slot="{ componentField }">
          <FormItem class="flex-1">
            <FormLabel>{{ t('labels.form.name') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('labels.form.namePlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="color" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('labels.form.color') }}</FormLabel>
            <FormControl>
              <ColorPicker v-bind="componentField" defaultColor="#6366F1" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <Button type="submit">
          {{ t('labels.form.submit') }}
        </Button>
      </form>
    </div>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="labels.length === 0" :message="t('labels.empty')" />
    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead :class="[fallbackColor]">{{ t('labels.columns.color') }}</TableHead>
          <TableHead>{{ t('labels.columns.name') }}</TableHead>
          <TableHead>{{ t('labels.columns.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="label in labels" :key="label.id">
          <TableCell>
            <span
              class="inline-block w-4 h-4 rounded-sm"
              :style="{ backgroundColor: isValidColor(editingId === label.id ? editColor : label.color) ? (editingId === label.id ? editColor : label.color) : fallbackColor }"
            />
          </TableCell>
          <TableCell>
            <div v-if="editingId === label.id" class="flex items-center gap-2">
              <Input v-model="editName" class="max-w-[200px]" />
              <ColorPicker v-model="editColor" defaultColor="#6366F1" />
            </div>
            <span v-else>{{ label.name }}</span>
          </TableCell>
          <TableCell>
            <div class="flex items-center gap-2">
              <template v-if="editingId === label.id">
                <Button size="sm" @click="saveEdit(label)">{{ t('common.save') }}</Button>
                <Button size="sm" variant="outline" @click="cancelEdit">{{ t('common.cancel') }}</Button>
              </template>
              <template v-else>
                <Button size="sm" variant="outline" @click="startEdit(label)">
                  {{ t('common.edit') }}
                </Button>
                <Button variant="destructive" size="sm" @click="deleteLabel(label.id)">
                  {{ t('labels.actions.delete') }}
                </Button>
              </template>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
