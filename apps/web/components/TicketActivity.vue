<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { withMentionChips } from '~/lib/mentions'
import MarkdownEditor from '~/components/MarkdownEditor.vue'
import CommentThread from '~/components/CommentThread.vue'
import { renderMarkdownOrEscape } from '~/lib/markdown'

interface Ticket {
  id: string
  description?: string | null
  [key: string]: unknown
}

const props = defineProps<{
  ticket: Ticket
  projectSlug: string
  ticketRef: string
  editing: boolean
  editDescription: string
}>()

const emit = defineEmits<{
  (e: 'update:editDescription', value: string): void
}>()

const { t } = useI18n()

const memberNames = useProjectMemberNames(props.projectSlug)
onMounted(() => { void memberNames.load().catch(() => undefined) })

const renderedDescription = computed(() =>
  props.ticket.description
    ? renderMarkdownOrEscape(withMentionChips(props.ticket.description, id => memberNames.nameOf(id)))
    : '',
)

const sectionHeadingClass = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'
</script>

<template>
  <div class="min-w-0 space-y-8">
    <section v-if="ticket.description || editing" class="space-y-2" aria-label="Description">
      <h2 :class="sectionHeadingClass">{{ t('tickets.detail.description') }}</h2>
      <MarkdownEditor
        v-if="editing"
        :model-value="editDescription"
        :mention-slug="projectSlug"
        :aria-label="t('tickets.detail.description')"
        @update:model-value="emit('update:editDescription', $event)"
      />
      <div
        v-else-if="renderedDescription"
        class="whitespace-pre-wrap rounded-lg border bg-card p-4 text-sm"
        v-html="renderedDescription"
      />
    </section>

    <section class="space-y-3" aria-label="Activity">
      <h2 :class="sectionHeadingClass">{{ t('tickets.detail.activity') }}</h2>
      <CommentThread
        :project-slug="projectSlug"
        :ticket-ref="ticketRef"
      />
    </section>
  </div>
</template>
