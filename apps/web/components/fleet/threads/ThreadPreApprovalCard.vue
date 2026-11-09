<script setup lang="ts">
import { computed, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useThreadPreApproval } from '~/composables/useThreadPreApproval'
import { usd } from '~/lib/fleet-analytics-format'
import { buildPreApprovalSchema } from '~/lib/fleet-flow-start-form'
import type { ThreadDetailDto } from '~/lib/thread-types'

const props = defineProps<{ slug: string; thread: ThreadDetailDto }>()
const emit = defineEmits<{ (event: 'changed'): void }>()
const { permissions } = useProjectPermissions(props.slug)
const { t } = useI18n()
const toast = useAppToast()
const { set, clear } = useThreadPreApproval(props.slug)
const cap = ref<number | string>('')
const validationError = ref('')
const writing = ref(false)

async function write(action: () => ReturnType<typeof set> | ReturnType<typeof clear>): Promise<void> {
  if (writing.value) return
  writing.value = true
  try {
    const result = await action()
    if (result.kind === 'done') emit('changed')
    else toast.success(t('fleet.flows.toast.approvalRequested'))
  }
  catch (error) {
    toast.error(extractApiError(error))
  }
  finally {
    writing.value = false
  }
}

function onSet(): void {
  if (writing.value) return
  validationError.value = ''
  const result = buildPreApprovalSchema(t).safeParse({ costCapUsd: cap.value })
  if (!result.success) {
    validationError.value = t('fleet.flows.preapproval.validation')
    return
  }
  void write(() => set(props.thread.id, result.data.costCapUsd))
}

function onClear(): void {
  void write(() => clear(props.thread.id))
}
const visible = computed(() =>
  props.thread.kind === 'REPO'
  && props.thread.archivedAt === null
  && permissions.value.has('fleet.thread.preapprove'))
</script>

<template>
  <section v-if="visible" class="space-y-2" data-testid="thread-preapproval-card">
    <h2 class="text-lg font-semibold">{{ t('fleet.flows.preapproval.title') }}</h2>
    <template v-if="thread.preApproval">
      <p>{{ t('fleet.flows.preapproval.cap') }}: {{ usd(thread.preApproval.costCapUsd) }}</p>
      <p>{{ t('fleet.flows.preapproval.setAt') }}: {{ new Date(thread.preApproval.at).toLocaleString() }}</p>
      <Button type="button" variant="outline" data-testid="preapproval-clear" :disabled="writing" @click="onClear">
        {{ t('fleet.flows.preapproval.clear') }}
      </Button>
    </template>
    <template v-else>
      <Label for="thread-preapproval-cap">{{ t('fleet.flows.preapproval.cap') }}</Label>
      <Input id="thread-preapproval-cap" v-model="cap" type="number" data-testid="preapproval-cap-input" />
      <p v-if="validationError" role="alert">{{ validationError }}</p>
      <Button type="button" data-testid="preapproval-set" :disabled="writing" @click="onSet">
        {{ t('fleet.flows.preapproval.set') }}
      </Button>
    </template>
  </section>
</template>
