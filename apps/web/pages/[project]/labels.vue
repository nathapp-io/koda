<script setup lang="ts">
import { toast } from 'vue-sonner'

interface Label {
  id: string
  name: string
  color: string
  description?: string | null
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()

const { data: labelsData, refresh } = useAsyncData(
  `labels-${slug}`,
  () => $api.get<Label[]>(`/projects/${slug}/labels`),
)

const labels = computed(() => labelsData.value ?? [])

const newLabelName = ref('')
const newLabelColor = ref('#6366f1')
const newLabelDescription = ref('')
const creating = ref(false)

async function handleCreate() {
  if (!newLabelName.value.trim()) return
  creating.value = true
  try {
    await $api.post(`/projects/${slug}/labels`, {
      name: newLabelName.value.trim(),
      color: newLabelColor.value || '#6366f1',
      description: newLabelDescription.value.trim() || undefined,
    })
    toast.success(t('labels.toast.created'))
    newLabelName.value = ''
    newLabelColor.value = '#6366f1'
    newLabelDescription.value = ''
    refresh()
  } catch (err) {
    toast.error(t('labels.toast.createFailed'))
  } finally {
    creating.value = false
  }
}

async function handleDelete(label: Label) {
  try {
    await $api.delete(`/projects/${slug}/labels/${label.id}`)
    toast.success(t('labels.toast.deleted'))
    refresh()
  } catch (err) {
    toast.error(t('labels.toast.deleteFailed'))
  }
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">{{ t('labels.title') }}</h1>

    <!-- Create label form -->
    <form class="flex items-end gap-3" @submit.prevent="handleCreate">
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium">{{ t('labels.form.name') }}</label>
        <Input v-model="newLabelName" :placeholder="t('labels.form.namePlaceholder')" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium">{{ t('labels.form.color') }}</label>
        <Input v-model="newLabelColor" placeholder="#6366f1" />
      </div>
      <Button type="submit" :disabled="creating">
        {{ creating ? t('common.loading') : t('labels.form.create') }}
      </Button>
    </form>

    <!-- Labels table -->
    <div v-if="labels.length > 0">
      <Table>
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
                class="inline-block w-4 h-4 rounded-full"
                :style="{ backgroundColor: label.color }"
              />
            </TableCell>
            <TableCell>{{ label.name }}</TableCell>
            <TableCell>
              <Button variant="destructive" size="sm" @click="handleDelete(label)">
                {{ t('labels.actions.delete') }}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <!-- Empty state -->
    <div v-else class="py-8 text-center text-muted-foreground">
      {{ t('labels.empty') }}
    </div>
  </div>
</template>
