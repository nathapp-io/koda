<template>
  <NuxtLink
    v-if="canDecide"
    :to="`/${slug}/approvals`"
    :class="navLinkClass"
    :active-class="activeClass"
  >
    <Inbox class="h-4 w-4 shrink-0" />
    {{ t('nav.approvals') }}
  </NuxtLink>
  <NuxtLink
    v-if="canReadPolicies"
    :to="`/${slug}/approval-policies`"
    :class="navLinkClass"
    :active-class="activeClass"
  >
    <ScrollText class="h-4 w-4 shrink-0" />
    {{ t('nav.approvalPolicies') }}
  </NuxtLink>
</template>

<script setup lang="ts">
/**
 * P3b US-006: the project block's two approval-engine links.
 *
 * They live in a child because `useProjectPermissions(slug)` takes a fixed slug: the layout's route
 * changes while it renders, and a composable handed one slug cannot answer for the next. The layout
 * mounts this component keyed by the route's slug, so a project change is a fresh read of the new
 * project's keys.
 *
 * The gates are the keys the two pages need, never a role name:
 * - the inbox link follows `mayDecide()`, because a narrowed `approval.decide@<pattern>` is a decide
 *   key the caller holds and `has('approval.decide')` would answer false for it;
 * - the policy link follows `approval.policy.read` (`GET /projects/:slug/approval-policies`).
 */
import { computed } from 'vue'
import { Inbox, ScrollText } from 'lucide-vue-next'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const { permissions } = useProjectPermissions(props.slug)

const canDecide = computed(() => permissions.value.mayDecide())
const canReadPolicies = computed(() => permissions.value.has('approval.policy.read'))

// The sidebar's own link classes are script-local to layouts/default.vue (this component is handed
// only its slug), so the two strings are mirrored here rather than passed in.
const navLinkClass =
  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer'
const activeClass = 'bg-accent text-accent-foreground'
</script>
