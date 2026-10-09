<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref as vueRef } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface AssigneeItem {
  type: 'user' | 'agent'
  id: string
  name: string
  secondary: string
  status?: string
}

const props = defineProps<{ projectSlug: string; disabled?: boolean }>()
const emit = defineEmits<{
  (e: 'select', value: { type: 'user' | 'agent'; id: string }): void
}>()

const { $api } = useApi()
const { t } = useI18n()

const search = vueRef('')
const items = vueRef<AssigneeItem[]>([])
const loading = vueRef(false)

const userItems = computed(() => items.value.filter((item) => item.type === 'user'))
const agentItems = computed(() => items.value.filter((item) => item.type === 'agent'))

let requestSeq = 0
let debounceHandle: ReturnType<typeof setTimeout> | null = null

function clearDebounce(): void {
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle)
    debounceHandle = null
  }
}

async function fetchAssignees(query: string): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  try {
    const response = await $api.get<{ items: AssigneeItem[] }>(apiPath`/projects/${props.projectSlug}/assignees`, {
      query: { q: query },
    })
    if (seq !== requestSeq) return
    items.value = response.items ?? []
  } catch (err: unknown) {
    if (seq !== requestSeq) return
    items.value = []
    try {
      useAppToast().error(extractApiError(err))
    } catch {
      // No toast in scope (e.g. tests); the empty result still signals the failure.
    }
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function onSearchUpdate(value: string): void {
  search.value = value
  clearDebounce()
  // Empty input: show the full roster right away so the picker never sits empty
  // when a user just opens it. Non-empty input is the typing flow that needs a
  // 200 ms debounce (AC1).
  if (value === '') {
    fetchAssignees('')
    return
  }
  debounceHandle = setTimeout(() => {
    fetchAssignees(value)
  }, 200)
}

function onPick(item: AssigneeItem): void {
  emit('select', { type: item.type, id: item.id })
}

function isPaused(item: AssigneeItem): boolean {
  return item.type === 'agent' && item.status === 'PAUSED'
}

// Initial load: open the picker with the full roster immediately so the user
// can pick without typing first.
onMounted(() => {
  fetchAssignees('')
})

// Drop a pending debounce and ignore any in-flight response once the picker
// is gone, so no request or toast fires after unmount.
onBeforeUnmount(() => {
  clearDebounce()
  requestSeq++
})
</script>

<template>
  <div class="space-y-2" data-testid="assignee-picker">
    <Input
      :model-value="search"
      data-testid="assignee-search"
      :placeholder="t('tickets.assignee.searchPlaceholder')"
      :aria-label="t('tickets.assignee.searchPlaceholder')"
      :disabled="disabled"
      @update:model-value="onSearchUpdate"
    />
    <div v-if="userItems.length > 0" data-testid="assignee-group-people">
      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {{ t('tickets.assignee.group.people') }}
      </p>
      <ul class="mt-1 space-y-1">
        <li v-for="item in userItems" :key="item.id">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-2 py-1 text-left text-sm hover:bg-muted"
            :data-testid="`assignee-option-${item.id}`"
            :disabled="disabled"
            @click="onPick(item)"
          >
            <span class="truncate">{{ item.name }}</span>
            <span class="truncate text-xs text-muted-foreground">{{ item.secondary }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div v-if="agentItems.length > 0" data-testid="assignee-group-agents">
      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {{ t('tickets.assignee.group.agents') }}
      </p>
      <ul class="mt-1 space-y-1">
        <li v-for="item in agentItems" :key="item.id">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-2 py-1 text-left text-sm hover:bg-muted"
            :data-testid="`assignee-option-${item.id}`"
            :disabled="disabled"
            @click="onPick(item)"
          >
            <span class="truncate">
              {{ item.name }}
              <span v-if="isPaused(item)" class="text-xs text-muted-foreground">{{ t('tickets.assignee.pausedTag') }}</span>
            </span>
            <span class="truncate text-xs text-muted-foreground">{{ item.secondary }}</span>
          </button>
        </li>
      </ul>
    </div>
    <p
      v-if="!loading && userItems.length === 0 && agentItems.length === 0"
      class="text-xs text-muted-foreground"
    >
      {{ t('tickets.assignee.empty') }}
    </p>
  </div>
</template>
