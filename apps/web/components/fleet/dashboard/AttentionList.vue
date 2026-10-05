<script setup lang="ts">
import { computed } from 'vue'
import { attentionLink, attentionMessage, renderText, severityOf } from '~/lib/fleet-dashboard'
import type { I18nText } from '~/lib/fleet-dashboard'
import type { AttentionItem, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2: what needs a human, in server order (errors first). Every line is worded here (D418). */
const props = defineProps<{ items: readonly AttentionItem[]; generatedAt: string; now: Date; scope: ScopeKind }>()
const { t, te } = useI18n()

const say = (text: I18nText): string => renderText(text, (key, named) => t(key, named ?? {}), te)

const rows = computed(() =>
  props.items.map((item) => {
    const message = attentionMessage(item, props.generatedAt, props.now)
    return {
      item,
      severity: severityOf(item),
      link: attentionLink(item, props.scope),
      summary: message.summary ? say(message.summary) : null,
      details: message.details.map(say),
      more: message.more,
    }
  }))
</script>

<template>
  <p v-if="items.length === 0" class="text-sm text-muted-foreground" data-testid="fleet-dashboard-all-clear">
    {{ t('fleet.dashboard.attention.allClear') }}
  </p>
  <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="fleet-dashboard-attention-list">
    <li
      v-for="row in rows"
      :key="row.item.key"
      class="flex items-start gap-3 p-3"
      data-testid="fleet-dashboard-attention-item"
      :data-key="row.item.key"
      :data-kind="row.item.kind"
      :data-severity="row.item.severity"
    >
      <Badge :variant="row.severity === 'error' ? 'destructive' : 'outline'" class="shrink-0">
        {{ t(`fleet.dashboard.severity.${row.severity}`) }}
      </Badge>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <NuxtLink
            v-if="row.link"
            :to="row.link"
            class="break-all font-medium text-primary underline-offset-4 hover:underline"
            data-testid="fleet-dashboard-attention-link"
          >{{ row.item.subjectName }}</NuxtLink>
          <span v-else class="break-all font-medium">{{ row.item.subjectName }}</span>
          <span
            v-if="scope === 'global' && row.item.projectSlug"
            class="text-xs text-muted-foreground"
            data-testid="fleet-dashboard-attention-project"
          >{{ row.item.projectSlug }}</span>
          <span v-if="row.item.since" class="text-xs text-muted-foreground"><FleetAge :iso="row.item.since" :now="now" mode="ago" /></span>
        </div>
        <p v-if="row.summary" class="text-sm" data-testid="fleet-dashboard-attention-summary">{{ row.summary }}</p>
        <ul v-if="row.details.length > 0" class="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          <li v-for="(detail, i) in row.details" :key="i" data-testid="fleet-dashboard-attention-detail">{{ detail }}</li>
        </ul>
        <p v-if="row.more > 0" class="text-xs text-muted-foreground" data-testid="fleet-dashboard-attention-more">
          {{ t('fleet.dashboard.attention.more', { n: row.more }) }}
        </p>
      </div>
    </li>
  </ul>
</template>
