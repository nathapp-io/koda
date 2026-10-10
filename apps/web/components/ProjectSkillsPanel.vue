<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import type { ProjectSkillDto } from '~/composables/useProjectSkills'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { list, enable, disable } = useProjectSkills()
const { data: viewer } = useProjectViewerRole(props.slug)
const canManage = computed(() => viewer.value?.canManage === true)

const skills = ref<ProjectSkillDto[]>([])
const loading = ref(true)
/** Skill ids with a toggle in flight; a switch is locked until its request settles. */
const pending = ref<Set<string>>(new Set())

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '—'
}

/** Flip one skill optimistically; put the switch back and toast the API message if the call fails. */
async function onToggle(skill: ProjectSkillDto, next: boolean): Promise<void> {
  if (pending.value.has(skill.id)) return
  const previous = skill.enabled
  skill.enabled = next
  pending.value = new Set([...pending.value, skill.id])
  try {
    if (next) await enable(props.slug, skill.id)
    else await disable(props.slug, skill.id)
  } catch (err: unknown) {
    skill.enabled = previous
    toast.error(extractApiError(err))
  } finally {
    const remaining = new Set(pending.value)
    remaining.delete(skill.id)
    pending.value = remaining
  }
}

onMounted(async () => {
  try {
    skills.value = await list(props.slug)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="rounded-md border border-border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">{{ t('skills.project.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('skills.project.description') }}</p>
    </div>

    <LoadingState v-if="loading" />
    <ul v-else class="divide-y divide-border">
      <li
        v-for="skill in skills"
        :key="skill.id"
        :data-testid="`skill-row-${skill.id}`"
        class="flex items-start justify-between gap-4 py-3"
      >
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{{ skill.name }}</span>
            <span
              class="font-mono text-xs text-muted-foreground"
              :data-testid="`skill-sha-${skill.id}`"
            >{{ shortSha(skill.source.resolvedSha) }}</span>
          </div>
          <p class="text-sm text-muted-foreground">{{ skill.description }}</p>
          <p v-if="skill.source.status === 'RESOLVE_FAILED'" class="text-xs text-status-rejected">
            {{ t('skills.project.sourceFailed') }}
          </p>
        </div>
        <Switch
          :data-testid="`skill-switch-${skill.id}`"
          :checked="skill.enabled"
          :disabled="!canManage || pending.has(skill.id)"
          @update:checked="onToggle(skill, $event)"
        />
      </li>
    </ul>
  </div>
</template>
