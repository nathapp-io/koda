<template>
  <div class="flex items-center gap-2">
    <Switch
      :checked="repo.fixAllowUnprotected"
      :disabled="!allowed || saving"
      :aria-label="t('fleet.repos.fixUnprotected.toggle')"
      @update:checked="toggle"
    />
    <span class="text-xs text-muted-foreground">{{ t('fleet.repos.fixUnprotected.hint') }}</span>
    <p v-if="notice" class="text-xs text-muted-foreground">{{ notice }}</p>
    <p v-if="error" role="alert" class="text-xs text-muted-foreground">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useFleetRepos } from '~/composables/useFleetRepos'
import type { FleetRepo } from '~/lib/fleet-types'

const props = defineProps<{ repo: FleetRepo }>()
const emit = defineEmits<{ (e: 'saved', repo: FleetRepo): void }>()
const { t } = useI18n()
const { permissions } = useGlobalPermissions()
const allowed = computed(() => permissions.value.has('fleet.repo.fix.unprotected'))
const { setFixUnprotected } = useFleetRepos()
const saving = ref(false)
const notice = ref('')
const error = ref('')

async function toggle(value: boolean): Promise<void> {
  saving.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await setFixUnprotected(props.repo.id, { allowUnprotected: value })
    if (result.kind === 'pending') notice.value = t('fleet.repos.fixUnprotected.pending')
    else emit('saved', result.repo)
  } catch (err: unknown) {
    error.value = extractApiError(err)
  } finally {
    saving.value = false
  }
}
</script>
