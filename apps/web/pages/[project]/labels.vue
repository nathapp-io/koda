<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'

interface Label {
  id: string
  name: string
  color: string
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()

const { data: labelsData, refresh } = useAsyncData(
  `labels-${slug}`,
  () => $api.get(`/projects/${slug}/labels`) as Promise<Label[]>,
)

const labels = computed(() => labelsData.value ?? [])

const formSchema = toTypedSchema(z.object({
  name: z.string().min(1, 'Name is required'),
  color: z.string().optional(),
}))

const { handleSubmit, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { name: '', color: '#6366f1' },
})

const onSubmit = handleSubmit(async (values) => {
  try {
    await $api.post(`/projects/${slug}/labels`, {
      name: values.name,
      color: values.color || '#6366f1',
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
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">{{ t('labels.title') }}</h1>

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
              <Input placeholder="#6366f1" class="w-32" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <Button type="submit">
          {{ t('labels.form.submit') }}
        </Button>
      </form>
    </div>

    <!-- Labels Table -->
    <div v-if="labels.length === 0" class="text-muted-foreground text-sm py-4">
      {{ t('labels.empty') }}
    </div>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('labels.columns.color') }}</TableHead>
          <TableHead>{{ t('labels.columns.name') }}</TableHead>
          <TableHead>{{ t('labels.columns.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="label in labels" :key="label.id">
          <TableCell>
            <span
              class="inline-block w-4 h-4 rounded-sm"
              :style="{ backgroundColor: label.color }"
            />
          </TableCell>
          <TableCell>{{ label.name }}</TableCell>
          <TableCell>
            <Button variant="destructive" size="sm" @click="deleteLabel(label.id)">
              {{ t('labels.actions.delete') }}
            </Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
