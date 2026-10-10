<script setup lang="ts">
import { Search, LayoutDashboard, Bot, Activity, Kanban, Tag, BookOpen, Clock, Brain, Code2, Rocket, Gauge, BarChart3, Settings, FolderKanban, SunMoon } from 'lucide-vue-next'
import type { Component } from 'vue'

interface Project { id: number; name: string; slug: string }
interface Command { id: string; label: string; hint?: string; icon: Component; run: () => void }

const props = defineProps<{ open: boolean; projectSlug?: string }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const { t } = useI18n()
const { $api } = useApi()
const colorMode = useColorMode()

const query = ref('')
const active = ref(0)
const projects = ref<Project[]>([])
const inputRef = ref<{ $el?: HTMLInputElement } | HTMLInputElement | null>(null)

const close = () => emit('update:open', false)
const go = (to: string) => () => { close(); void navigateTo(to) }

const commands = computed<Command[]>(() => {
  const list: Command[] = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, run: go('/') },
    { id: 'agents', label: t('nav.agents'), icon: Bot, run: go('/agents') },
    { id: 'slos', label: t('nav.slos'), icon: Activity, run: go('/admin/slos') },
  ]
  const slug = props.projectSlug
  if (slug) {
    const hint = slug
    list.push(
      { id: 'board', label: t('nav.board'), hint, icon: Kanban, run: go(`/${slug}`) },
      { id: 'labels', label: t('nav.labels'), hint, icon: Tag, run: go(`/${slug}/labels`) },
      { id: 'project-agents', label: t('nav.agents'), hint, icon: Bot, run: go(`/${slug}/agents`) },
      { id: 'kb', label: t('nav.kb'), hint, icon: BookOpen, run: go(`/${slug}/kb`) },
      { id: 'timeline', label: t('nav.timeline'), hint, icon: Clock, run: go(`/${slug}/timeline`) },
      { id: 'memory', label: t('nav.memory'), hint, icon: Brain, run: go(`/${slug}/memory`) },
      { id: 'code-intel', label: t('nav.codeIntel'), hint, icon: Code2, run: go(`/${slug}/code-intel`) },
      { id: 'fleet-overview', label: t('nav.fleetOverview'), hint, icon: Gauge, run: go(`/${slug}/fleet/overview`) },
      { id: 'fleet', label: t('nav.fleetJobs'), hint, icon: Rocket, run: go(`/${slug}/fleet`) },
      { id: 'analytics', label: t('nav.fleetAnalytics'), hint, icon: BarChart3, run: go(`/${slug}/fleet/analytics`) },
      { id: 'settings', label: t('nav.settings'), hint, icon: Settings, run: go(`/${slug}/settings`) },
    )
  }
  for (const p of projects.value) {
    list.push({ id: `project-${p.id}`, label: p.name, hint: t('palette.project'), icon: FolderKanban, run: go(`/${p.slug}`) })
  }
  list.push({
    id: 'theme',
    label: t('palette.toggleTheme'),
    icon: SunMoon,
    run: () => { colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'; close() },
  })
  return list
})

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q))
})

watch(query, () => { active.value = 0 })

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  query.value = ''
  active.value = 0
  try {
    projects.value = await $api.get<Project[]>('/projects')
  } catch {
    projects.value = [] // palette still works for static destinations
  }
  await nextTick()
  const el = inputRef.value
  ;(el instanceof HTMLInputElement ? el : el?.$el)?.focus()
})

function onKeydown(e: KeyboardEvent) {
  const n = results.value.length
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = n ? (active.value + 1) % n : 0 }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = n ? (active.value - 1 + n) % n : 0 }
  else if (e.key === 'Enter') { e.preventDefault(); results.value[active.value]?.run() }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl" @keydown="onKeydown">
      <DialogTitle class="sr-only">{{ t('palette.title') }}</DialogTitle>
      <DialogDescription class="sr-only">{{ t('palette.description') }}</DialogDescription>
      <div class="flex items-center gap-2 border-b border-border px-4">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          :aria-activedescendant="results[active] ? `palette-${results[active].id}` : undefined"
          :placeholder="t('palette.placeholder')"
          class="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        >
      </div>
      <ul id="palette-list" role="listbox" class="max-h-80 overflow-y-auto p-2">
        <li
          v-for="(cmd, i) in results"
          :id="`palette-${cmd.id}`"
          :key="cmd.id"
          role="option"
          :aria-selected="i === active"
          :class="[
            'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm',
            i === active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
          ]"
          @mousemove="active = i"
          @click="cmd.run()"
        >
          <component :is="cmd.icon" class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="flex-1 truncate">{{ cmd.label }}</span>
          <span v-if="cmd.hint" class="truncate text-xs text-muted-foreground">{{ cmd.hint }}</span>
        </li>
        <li v-if="results.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t('palette.empty') }}
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>
