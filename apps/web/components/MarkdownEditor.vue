<script setup lang="ts">
import { ref, computed, nextTick, useId } from 'vue'
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
const active = ref(0)
const listId = `mention-list-${useId()}`
/** The textarea the user is typing in, so a pick can put the caret back after the token. */
let textareaEl: HTMLTextAreaElement | null = null

// M24: renderMarkdownOrEscape catches renderer errors and escapes the raw text,
// so the v-html below never receives unsanitized input.
const renderedHtml = computed(() =>
  renderMarkdownOrEscape(withMentionChips(props.modelValue || '', id => memberNames?.nameOf(id) ?? null)),
)

const candidates = computed<readonly ProjectMember[]>(() =>
  mention.value && memberNames ? filterMentionCandidates(memberNames.members.value, mention.value.query) : [],
)
const pickerOpen = computed(() => mention.value !== null && candidates.value.length > 0)
const optionId = (index: number): string => `${listId}-${index}`

function ensureMembers(): void {
  if (!memberNames || membersRequested) return
  membersRequested = true
  memberNames.load().catch(() => { membersRequested = false })
}

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  textareaEl = target
  emit('update:modelValue', target.value)
  if (!memberNames) return
  const caret = target.selectionStart ?? target.value.length
  const query = mentionQuery(target.value, caret)
  mention.value = query ? { ...query, caret } : null
  active.value = 0
  if (query) ensureMembers()
}

function pick(member: ProjectMember) {
  if (!mention.value) return
  const next = insertMention(props.modelValue || '', mention.value.start, mention.value.caret, member.name || member.email, member.userId)
  mention.value = null
  emit('update:modelValue', next.text)
  const el = textareaEl
  if (el) void nextTick(() => { el.focus(); el.setSelectionRange(next.caret, next.caret) })
}

const PICKER_KEYS: Readonly<Record<string, (count: number) => void>> = {
  ArrowDown: (count) => { active.value = (active.value + 1) % count },
  ArrowUp: (count) => { active.value = (active.value - 1 + count) % count },
}

/** Picker keyboard: arrows move, Enter/Tab pick, Escape closes; every key behaves normally when no picker shows. */
function handleKeydown(event: KeyboardEvent) {
  if (!pickerOpen.value) return
  const count = candidates.value.length
  const move = PICKER_KEYS[event.key]
  if (move) {
    event.preventDefault()
    move(count)
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    pick(candidates.value[Math.min(active.value, count - 1)])
  } else if (event.key === 'Escape') {
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
          aria-autocomplete="list"
          :aria-controls="pickerOpen ? listId : undefined"
          :aria-activedescendant="pickerOpen ? optionId(active) : undefined"
          @input="handleInput"
          @keydown="handleKeydown"
        />
        <ul
          v-if="pickerOpen"
          :id="listId"
          role="listbox"
          :aria-label="t('notifications.mentions.pickerLabel')"
          class="absolute left-2 top-full z-40 mt-1 w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          data-testid="mention-picker"
        >
          <li
            v-for="(member, index) in candidates"
            :id="optionId(index)"
            :key="member.userId"
            role="option"
            :aria-selected="index === active ? 'true' : 'false'"
          >
            <button
              type="button"
              tabindex="-1"
              class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              :class="{ 'bg-accent': index === active }"
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
