<script setup lang="ts">
import { toast } from 'vue-sonner'

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

const newName = ref('')
const newColor = ref('#6366f1')

async function createLabel() {
  try {
    await $api.post(`/projects/${slug}/labels`, {
      name: newName.value,
      color: newColor.value || '#6366f1',
    })
    toast.success(t('labels.toast.created'))
    newName.value = ''
    newColor.value = '#6366f1'
    refresh()
  } catch {
    toast.error(t('labels.toast.createFailed'))
  }
}

async function deleteLabel(labelId: string) {
  try {
    await $api.delete(`/projects/${slug}/labels/${labelId}`)
    toast.success(t('labels.toast.deleted'))
    refresh()
  } catch {
    toast.error(t('labels.toast.deleteFailed'))
  }
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">{{ t('labels.title') }}</h1>

    <!-- Create Label Form -->
    <div class="rounded-md border border-border p-4 space-y-4">
      <h2 class="text-lg font-semibold">{{ t('labels.form.create') }}</h2>
      <div class="flex items-end gap-4">
        <div class="flex-1 space-y-1">
          <label class="text-sm font-medium">{{ t('labels.form.name') }}</label>
          <Input v-model="newName" :placeholder="t('labels.form.namePlaceholder')" />
        </div>
        <div class="space-y-1">
          <label class="text-sm font-medium">{{ t('labels.form.color') }}</label>
          <Input v-model="newColor" placeholder="#6366f1" class="w-32" />
        </div>
        <Button @click="createLabel" :disabled="!newName.trim()">
          {{ t('labels.form.submit') }}
        </Button>
      </div>
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
