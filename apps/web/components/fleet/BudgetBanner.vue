<template>
  <div v-if="view.lines.length > 0" class="space-y-2" data-testid="fleet-budget-banner">
    <div
      v-for="line in view.lines"
      :key="line.policy.id"
      class="rounded-md border px-3 py-2 text-sm"
      :class="line.status === 'paused' ? 'border-destructive text-destructive' : 'border-border bg-muted'"
      :role="line.status === 'paused' ? 'alert' : 'status'"
      data-testid="fleet-budget-banner-line"
      :data-status="line.status"
      :data-policy="line.policy.id"
    >
      {{ lineText(line) }}
    </div>
    <div class="flex items-center gap-3 text-sm">
      <span v-if="view.more > 0" class="text-muted-foreground" data-testid="fleet-budget-banner-more">
        {{ t('fleet.budgets.banner.more', { count: view.more }) }}
      </span>
      <NuxtLink
        :to="`/${slug}/fleet/budgets`"
        class="font-medium text-primary underline-offset-4 hover:underline"
        data-testid="fleet-budget-banner-link"
      >
        {{ t('fleet.budgets.banner.view') }}
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import { bannerLines, scopeName, scopeText, spendPercent } from '~/lib/fleet-budgets'
import type { BannerLine } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'

/** D179: the banner polls for itself; the jobs list also nudges it on fleet_job notices. */
const POLL_MS = 30_000

const props = defineProps<{ slug: string; repoName?: (id: string) => string }>()

const { t } = useI18n()
const { policies, load } = useFleetBudgets({ kind: 'project', slug: props.slug })

const view = computed(() => bannerLines(policies.value))

async function refresh(): Promise<void> {
  try {
    await load()
  } catch {
    // Cosmetic on a page about something else: keep what was shown and try again at the next poll.
  }
}

const polling = useVisiblePolling(refresh, POLL_MS)
onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(polling.stop)
defineExpose({ refresh })

const nameFor = (line: BannerLine): string | null =>
  scopeName(line.policy, {
    project: props.slug,
    repo: (id) => props.repoName?.(id) ?? id,
    runner: (id) => id,
  })

const lineText = (line: BannerLine): string =>
  t(`fleet.budgets.banner.${line.status}`, {
    scope: scopeText(t, line.policy, nameFor(line)),
    spent: formatUsd(line.policy.spentUsd),
    amount: formatUsd(line.policy.amountUsd),
    percent: spendPercent(line.policy.spentUsd, line.policy.amountUsd),
  })
</script>
