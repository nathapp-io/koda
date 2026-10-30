<template>
  <div v-if="view.lines.length > 0" class="space-y-2" data-testid="fleet-budget-banner">
    <div
      v-for="line in view.lines"
      :key="line.policy.id"
      class="rounded-md border px-3 py-2 text-sm"
      :class="line.status === 'paused' ? 'border-destructive text-status-rejected' : 'border-border bg-muted'"
      :role="line.status === 'paused' ? 'alert' : 'status'"
      data-testid="fleet-budget-banner-line"
      :data-status="line.status"
      :data-policy="line.policy.id"
    >
      {{ lineText(line) }}
      <NuxtLink
        v-if="line.status === 'paused' && reviewIds.get(line.policy.id)"
        :to="inboxHref(slug, reviewIds.get(line.policy.id))"
        class="ml-2 font-medium underline-offset-4 hover:underline"
        data-testid="fleet-budget-banner-review"
        :data-policy="line.policy.id"
      >
        {{ t('fleet.budgets.banner.review') }}
      </NuxtLink>
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useApprovalInbox } from '~/composables/useApprovalInbox'
import type { JobApprovalRow } from '~/composables/useApprovalInbox'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import { useProjectRef } from '~/composables/useProjectRef'
import { BUDGET_APPROVAL_KEY, budgetAskOf } from '~/lib/approval-request-fleet'
import { DETAIL_FETCH_LIMIT, inboxHref } from '~/lib/approval-requests'
import { bannerLines, scopeName, scopeText, spendPercent } from '~/lib/fleet-budgets'
import type { BannerLine } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'

/** D179: the banner polls for itself; the jobs list also nudges it on fleet_job notices. */
const POLL_MS = 30_000

const props = defineProps<{ slug: string; repoName?: (id: string) => string }>()

const { t } = useI18n()
const { policies, load } = useFleetBudgets({ kind: 'project', slug: props.slug })

const view = computed(() => bannerLines(policies.value))

/** P3b US-007: the engine lists on the project's **id**, while every project page routes on the slug. */
const project = useProjectRef(props.slug)
const inbox = useApprovalInbox()
/** D248: policy id -> the engine request that would raise it; empty until a load succeeds. */
const reviewIds = ref<ReadonlyMap<string, string>>(new Map())

/** The policy each detailed stop names; a row whose detail failed or is past the limit contributes nothing. */
function policyLinks(rows: readonly JobApprovalRow[]): ReadonlyMap<string, string> {
  const links = new Map<string, string>()
  for (const row of rows) {
    const policyId = row.detail === null ? null : budgetAskOf(row.detail)?.policyId ?? null
    if (policyId !== null) links.set(policyId, row.request.id)
  }
  return links
}

async function loadReviews(): Promise<void> {
  try {
    // Resolved once the page knows the id: the list filter is by projectId, not slug.
    const projectId = project.id.value ?? await project.load()
    if (projectId === null) return
    // status=pending & permissionKey=fleet.budget.override & projectId -> one page of 100, the first
    // DETAIL_FETCH_LIMIT rows detailed (`budgetAskOf(detail).policyId` is what names the policy).
    reviewIds.value = policyLinks(await inbox.listDetailed(
      { status: 'pending', permissionKey: BUDGET_APPROVAL_KEY, projectId },
      DETAIL_FETCH_LIMIT,
    ))
  } catch {
    // Cosmetic on a page about something else: keep the links already shown and retry at the next
    // poll or approval_request notice — an empty map would flash the review links away.
  }
}

async function refresh(): Promise<void> {
  try {
    await Promise.all([load(), loadReviews()])
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
// P3b US-007: the engine publishes nothing for a request without a project, so a project page's own
// stream is what makes a new stop's review link appear before the next poll.
useProjectEvents(props.slug, {
  onApprovalRequest: () => { void polling.runNow() },
  onResync: () => { void polling.runNow() },
})
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
