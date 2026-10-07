<script setup lang="ts">
import { computed } from 'vue'
import { fileStatus, type ConfigDraft } from '~/lib/nax-config'
import { lineDiff } from '~/lib/nax-config-diff'

const props = defineProps<{ draft: ConfigDraft; readonly: boolean }>()
const emit = defineEmits<{ (e: 'discard', path: string): void; (e: 'discardAll'): void; (e: 'resolve', path: string): void }>()
const { t } = useI18n()

// Not read directly in the template: Nuxt's auto-import globals `readonly` / `isReadonly`
// (Vue's reactivity API) shadow the prop there and vue-tsc fails TS2774 on `v-if="!readonly"`.
const viewOnly = computed(() => props.readonly)

const PREFIX = { same: '  ', add: '+ ', del: '- ' } as const

const changes = computed(() => Object.values(props.draft.files)
  .slice()
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((file) => ({ file, status: fileStatus(props.draft, file.path), diff: lineDiff(file.original ?? '', file.content ?? '') })))
</script>

<template>
  <section class="space-y-3" data-testid="nax-changes">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium">{{ t('fleet.config.changes.title', { count: changes.length }) }}</h2>
      <Button v-if="!viewOnly" variant="outline" size="sm" data-testid="nax-changes-discard-all" @click="emit('discardAll')">{{ t('fleet.config.changes.discardAll') }}</Button>
    </div>
    <article v-for="c in changes" :key="c.file.path" class="rounded-md border border-border" data-testid="nax-change" :data-path="c.file.path">
      <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span class="font-mono text-xs">{{ c.file.path }}</span>
        <Badge variant="outline">{{ t(`fleet.config.status.${c.status}`) }}</Badge>
        <Badge v-if="c.file.conflict" variant="destructive" data-testid="nax-change-conflict">{{ t('fleet.config.changes.conflict') }}</Badge>
        <span class="ml-auto flex gap-2">
          <Button v-if="!viewOnly && c.file.conflict" size="sm" variant="outline" data-testid="nax-change-resolve" @click="emit('resolve', c.file.path)">{{ t('fleet.config.changes.resolve') }}</Button>
          <Button v-if="!viewOnly" size="sm" variant="ghost" data-testid="nax-change-discard" @click="emit('discard', c.file.path)">{{ t('fleet.config.changes.discard') }}</Button>
        </span>
      </header>
      <p v-if="c.file.conflict" class="px-3 pt-2 text-xs text-muted-foreground">{{ t('fleet.config.changes.conflictHelp') }}</p>
      <p v-if="c.diff.approximate" class="px-3 pt-2 text-xs text-muted-foreground">{{ t('fleet.config.changes.approximate') }}</p>
      <pre class="max-h-80 overflow-auto p-3 font-mono text-xs"><span
        v-for="(line, i) in c.diff.lines"
        :key="i"
        data-testid="nax-diff-line"
        :data-kind="line.kind"
        :class="['block', line.kind === 'add' ? 'bg-green-500/10' : line.kind === 'del' ? 'bg-red-500/10' : '']"
      >{{ PREFIX[line.kind] }}{{ line.text }}</span></pre>
    </article>
  </section>
</template>
