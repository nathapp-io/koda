<script setup lang="ts">
const props = defineProps<{ projectSlug: string }>()
const emit = defineEmits<{ 'added': [] }>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const open = ref(false)
const loading = ref(false)

const form = reactive({
  sourceId: '',
  source: 'manual' as 'manual' | 'doc' | 'ticket',
  content: '',
})

function reset() {
  form.sourceId = ''
  form.source = 'manual'
  form.content = ''
}

async function submit() {
  if (!form.sourceId.trim() || !form.content.trim()) {
    toast.error(t('kb.validation.sourceIdRequired'))
    return
  }
  loading.value = true
  try {
    await $api.post(`/projects/${props.projectSlug}/kb/documents`, {
      sourceId: form.sourceId,
      source: form.source,
      content: form.content,
    })
    toast.success(t('kb.toast.docAdded'))
    open.value = false
    reset()
    emit('added')
  }
  catch {
    toast.error(t('kb.toast.addFailed'))
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button size="sm">{{ t('kb.documents.addButton') }}</Button>
    </DialogTrigger>
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('kb.documents.addTitle') }}</DialogTitle>
        <DialogDescription>{{ t('kb.documents.addDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-2">
        <!-- Source ID -->
        <div class="space-y-1.5">
          <Label for="sourceId">{{ t('kb.documents.fields.sourceId') }}</Label>
          <Input
            id="sourceId"
            v-model="form.sourceId"
            :placeholder="t('kb.documents.fields.sourceIdPlaceholder')"
          />
        </div>

        <!-- Source Type — button group avoids Radix Select portal issues in automation -->
        <div class="space-y-1.5">
          <Label>{{ t('kb.documents.fields.source') }}</Label>
          <div class="flex gap-2">
            <Button
              v-for="opt in (['manual', 'doc', 'ticket'] as const)"
              :key="opt"
              :variant="form.source === opt ? 'default' : 'outline'"
              size="sm"
              type="button"
              @click="form.source = opt"
            >
              {{ t(`kb.documents.fields.source${opt.charAt(0).toUpperCase() + opt.slice(1)}`) }}
            </Button>
          </div>
        </div>

        <!-- Content -->
        <div class="space-y-1.5">
          <Label for="content">{{ t('kb.documents.fields.content') }}</Label>
          <Textarea
            id="content"
            v-model="form.content"
            :placeholder="t('kb.documents.fields.contentPlaceholder')"
            rows="6"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button :disabled="loading" @click="submit">
          {{ loading ? t('common.loading') : t('kb.documents.addButton') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
