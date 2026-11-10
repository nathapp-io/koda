<template>
  <div>
    <Button size="sm" variant="outline" :data-testid="`fleet-repo-rules-${repo.owner}-${repo.name}`" @click="openDialog">
      {{ repo.ruleOverride ? t('fleet.repos.ruleOverride.open', { files: repo.ruleOverride.ruleFiles }) : t('fleet.repos.ruleOverride.openEmpty') }}
    </Button>
    <div v-if="open" role="dialog" aria-modal="true" class="fixed inset-0 z-50 overflow-auto bg-background p-6">
      <div class="mx-auto max-w-3xl space-y-4">
        <h2 class="text-lg font-semibold">{{ t('fleet.repos.ruleOverride.title') }}</h2>
        <div v-for="(rule, index) in rules" :key="index" class="grid gap-2 border-b border-border pb-3">
          <Input v-model="rule.path" :disabled="!allowed || saving" :aria-label="t('fleet.repos.ruleOverride.path')" />
          <Textarea v-model="rule.content" :disabled="!allowed || saving" :aria-label="t('fleet.repos.ruleOverride.content')" />
          <Button variant="outline" :disabled="!allowed || saving" @click="rules.splice(index, 1)">{{ t('fleet.repos.ruleOverride.remove') }}</Button>
        </div>
        <Button variant="outline" :disabled="!allowed || saving" @click="rules.push({ path: '', content: '' })">{{ t('fleet.repos.ruleOverride.addFile') }}</Button>
        <label class="block">{{ t('fleet.repos.ruleOverride.rulesMode') }}
          <select v-model="rulesMode" :disabled="!allowed || saving"><option value="merge">merge</option><option value="replace">replace</option></select>
        </label>
        <label class="block">{{ t('fleet.repos.ruleOverride.context') }}<Textarea v-model="contextContent" :disabled="!allowed || saving" /></label>
        <label class="block">{{ t('fleet.repos.ruleOverride.contextMode') }}
          <select v-model="contextMode" :disabled="!allowed || saving"><option value="append">append</option><option value="replace">replace</option></select>
        </label>
        <p v-if="pending" role="status">{{ t('fleet.repos.ruleOverride.pending') }}</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="flex gap-2">
          <Button :disabled="!allowed || saving" @click="save">{{ t('fleet.repos.ruleOverride.save') }}</Button>
          <Button variant="outline" :disabled="!allowed || saving" @click="clear">{{ t('fleet.repos.ruleOverride.clear') }}</Button>
          <Button variant="ghost" @click="open = false">{{ t('fleet.repos.ruleOverride.close') }}</Button>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useFleetRepos } from '~/composables/useFleetRepos'
import type { FleetRepo, FleetRuleOverride } from '~/lib/fleet-types'
const props = defineProps<{ repo: FleetRepo }>()
const emit = defineEmits<{ (e: 'saved', repo: FleetRepo): void }>()
const { t } = useI18n()
const { permissions } = useGlobalPermissions()
const allowed = computed(() => permissions.value.has('fleet.repo.rules.configure'))
const { getRuleOverride, setRuleOverride, clearRuleOverride } = useFleetRepos()
const open = ref(false)
const saving = ref(false)
const pending = ref(false)
const error = ref('')
const rules = ref<{ path: string; content: string }[]>([])
const rulesMode = ref<'merge' | 'replace'>('merge')
const contextContent = ref('')
const contextMode = ref<'append' | 'replace'>('append')
async function openDialog(): Promise<void> {
  open.value = true; error.value = ''; pending.value = false
  try {
    const data: FleetRuleOverride | null = await getRuleOverride(props.repo.id)
    rules.value = data?.rules.map((rule) => ({ ...rule })) ?? []
    rulesMode.value = data?.rulesMode ?? 'merge'
    contextContent.value = data?.context?.content ?? ''
    contextMode.value = data?.context?.mode ?? 'append'
  } catch (err: unknown) { error.value = extractApiError(err) }
}
async function save(): Promise<void> {
  saving.value = true; error.value = ''; pending.value = false
  try {
    const result = await setRuleOverride(props.repo.id, { rules: rules.value.map((r) => ({ ...r })), rulesMode: rulesMode.value, context: contextContent.value ? { content: contextContent.value, mode: contextMode.value } : null })
    if (result.kind === 'pending') pending.value = true
    else emit('saved', result.repo)
  } catch (err: unknown) { error.value = extractApiError(err) } finally { saving.value = false }
}
defineExpose({ openDialog, save, clear })
async function clear(): Promise<void> {
  saving.value = true; error.value = ''; pending.value = false
  try {
    const result = await clearRuleOverride(props.repo.id)
    if (result.kind === 'pending') pending.value = true
    else { rules.value = []; contextContent.value = ''; emit('saved', result.repo) }
  } catch (err: unknown) { error.value = extractApiError(err) } finally { saving.value = false }
}
</script>
