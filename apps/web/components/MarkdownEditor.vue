<script setup lang="ts">
import { ref, computed } from 'vue'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import { renderMarkdownOrEscape } from '~/lib/markdown'
import { filterMentionCandidates, insertMention, mentionQuery, withMentionChips } from '~/lib/mentions'
import type { ProjectMember } from '~/composables/useProjectMembers'

interface Props {
  modelValue: string
  /** S4a: the project whose members `@` offers; no picker when absent. */
  mentionSlug?: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

// The root is a Tabs component, so fallthrough attributes (e.g. aria-label
// passed by callers for axe's `label` rule) would land in the void. Forward
// them explicitly onto the editable Textarea instead.
defineOptions({ inheritAttrs: false })

const { t } = useI18n()
const activeTab = ref<'write' | 'preview'>('write')
const memberNames = props.mentionSlug ? useProjectMemberNames(props.mentionSlug) : null
let membersRequested = false
const mention = ref<{ start: number; caret: number; query: string } | null>(null)

// M24: renderMarkdownOrEscape catches renderer errors and escapes the raw text,
// so the v-html below never receives unsanitized input.
const renderedHtml = computed(() =>
  renderMarkdownOrEscape(withMentionChips(props.modelValue || '', id => memberNames?.nameOf(id) ?? null)),
)

const candidates = computed<readonly ProjectMember[]>(() =>
  mention.value && memberNames ? filterMentionCandidates(memberNames.members.value, mention.value.query) : [],
)

function ensureMembers(): void {
  if (!memberNames || membersRequested) return
  membersRequested = true
  memberNames.load().catch(() => { membersRequested = false })
}

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
  if (!memberNames) return
  const caret = target.selectionStart ?? target.value.length
  const query = mentionQuery(target.value, caret)
  mention.value = query ? { ...query, caret } : null
  if (query) ensureMembers()
}

function pick(member: ProjectMember) {
  if (!mention.value) return
  const next = insertMention(props.modelValue || '', mention.value.start, mention.value.caret, member.name || member.email, member.userId)
  mention.value = null
  emit('update:modelValue', next.text)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && mention.value) {
    event.stopPropagation()
    mention.value = null
  }
}
</script>

<template>
  <Tabs v-model="activeTab" class="w-full">
    <TabsList class="w-full justify-start border-b rounded-none bg-muted/50">
      <TabsTrigger value="write">Write</TabsTrigger>
      <TabsTrigger value="preview">Preview</TabsTrigger>
    </TabsList>
    <TabsContent value="write" class="mt-2">
      <div class="relative">
        <Textarea
          :model-value="modelValue"
          class="min-h-[200px] font-mono text-sm"
          v-bind="$attrs"
          @input="handleInput"
          @keydown="handleKeydown"
        />
        <ul
          v-if="mention && candidates.length > 0"
          role="listbox"
          :aria-label="t('notifications.mentions.pickerLabel')"
          class="absolute left-2 top-full z-40 mt-1 w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          data-testid="mention-picker"
        >
          <li v-for="member in candidates" :key="member.userId" role="option" aria-selected="false">
            <button
              type="button"
              class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              data-testid="mention-option"
              @mousedown.prevent="pick(member)"
            >
              <span class="truncate">{{ member.name || member.email }}</span>
              <span class="truncate text-xs text-muted-foreground">{{ member.email }}</span>
            </button>
          </li>
        </ul>
      </div>
    </TabsContent>
    <TabsContent value="preview" class="mt-2">
      <!-- marked renders fenced code blocks as <pre><code> elements -->
      <div
        class="min-h-[200px] p-4 border rounded-md bg-background overflow-auto prose prose-sm dark:prose-invert max-w-none"
        v-html="renderedHtml"
      />
    </TabsContent>
  </Tabs>
</template>
