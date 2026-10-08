<script setup lang="ts">
import { LayoutDashboard, Kanban, Bot, Tag, BookOpen, Clock, Brain, Code2, Activity, Users, Server, FolderGit2, Rocket, Wallet, Inbox, BarChart3, Gauge, Settings, Search, Menu } from 'lucide-vue-next'

const { t } = useI18n()
const auth = useAuth()
const route = useRoute()
const sidebarOpen = ref(true)
const paletteOpen = ref(false)

// Below the lg breakpoint the sidebar is a drawer: start closed, close again after navigating.
const isDrawer = () => import.meta.client && window.matchMedia('(max-width: 1023px)').matches

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  if (e.key === 'Escape' && sidebarOpen.value && isDrawer()) {
    sidebarOpen.value = false
  }
}

onMounted(() => {
  if (isDrawer()) sidebarOpen.value = false
  window.addEventListener('keydown', onGlobalKeydown)
  layoutReady.value = true
})
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
watch(() => route.path, () => {
  if (isDrawer()) sidebarOpen.value = false
})

// Drawer focus management: move focus into the drawer when it opens, restore it
// to the toggle when it closes. layoutReady guards the mount-time
// `sidebarOpen = false` above so it cannot steal focus on page load. flush:
// 'sync' is required for that guard to hold: a default (pre) watcher is
// queued and runs only after onMounted has already set layoutReady, so the
// mount-time close would still move focus.
const layoutReady = ref(false)

watch(sidebarOpen, (open) => {
  if (!layoutReady.value || !import.meta.client || !isDrawer()) return
  if (open) {
    nextTick(() => document.querySelector<HTMLElement>('#primary-nav a')?.focus())
  } else {
    document.getElementById('sidebar-toggle')?.focus()
  }
}, { flush: 'sync' })

const isGlobalAdmin = computed(() => auth.user.value?.role === 'ADMIN')

const projectSlug = computed(() => route.params.project as string | undefined)

const navLinkClass =
  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer'
const activeClass = 'bg-accent text-accent-foreground'
// Full muted-foreground, not an opacity step: at text-[11px] the /80 blend
// fails WCAG AA (4.13:1 over the card in light); the solid token clears it.
const sectionLabelClass = 'px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

/** The last crumb under `/:project/fleet/*`: overview, dispatch, budgets, approvals, analytics, or (anything else) a job. */
function fleetLeaf(project: string, path: string): string {
  if (path === `/${project}/fleet/overview`) return t('fleet.dashboard.title')
  if (path === `/${project}/fleet/dispatch`) return t('fleet.jobs.dispatch')
  if (path === `/${project}/fleet/budgets`) return t('fleet.budgets.title')
  if (path === `/${project}/fleet/approvals`) return t('fleet.approvals.title')
  if (path === `/${project}/fleet/analytics`) return t('fleet.analytics.title')
  return t('fleet.jobs.detail.title')
}

const breadcrumbItems = computed(() => {
  const project = projectSlug.value
  if (!project) return []

  const path = route.path

  if (path === '/agents') {
    return [{ label: 'Koda', to: '/' }, { label: t('nav.agents') }]
  }

  const projectBase = { label: project, to: `/${project}` }

  if (path === `/${project}`) {
    return [{ label: 'Koda', to: '/' }, { label: project }]
  }
  if (path === `/${project}/labels`) {
    return [{ label: 'Koda', to: '/' }, projectBase, { label: t('nav.labels') }]
  }
  if (path === `/${project}/kb`) {
    return [{ label: 'Koda', to: '/' }, projectBase, { label: t('nav.kb') }]
  }

  if (path === `/${project}/fleet`) {
    return [{ label: 'Koda', to: '/' }, projectBase, { label: t('nav.fleetJobs') }]
  }
  const fleetJobs = { label: t('nav.fleetJobs'), to: `/${project}/fleet` }
  if (path === `/${project}/fleet/schedules`) {
    return [{ label: 'Koda', to: '/' }, projectBase, fleetJobs, { label: t('fleet.schedules.title') }]
  }
  if (path.startsWith(`/${project}/fleet/schedules/`)) {
    const schedules = { label: t('fleet.schedules.title'), to: `/${project}/fleet/schedules` }
    return [{ label: 'Koda', to: '/' }, projectBase, fleetJobs, schedules, { label: t('fleet.schedules.detailTitle') }]
  }
  if (path.startsWith(`/${project}/fleet/`)) {
    const leaf = fleetLeaf(project, path)
    return [{ label: 'Koda', to: '/' }, projectBase, { label: t('nav.fleetJobs'), to: `/${project}/fleet` }, { label: leaf }]
  }

  const ticketRef = (route.params.ref as string | undefined)
  if (ticketRef) {
    return [
      { label: 'Koda', to: '/' },
      projectBase,
      { label: t('nav.tickets'), to: `/${project}` },
      { label: ticketRef },
    ]
  }

  return [{ label: 'Koda', to: '/' }, { label: project }]
})

const backTo = computed(() => {
  const project = projectSlug.value
  if (!project) return '/'
  if (route.path === `/${project}`) return '/'
  return `/${project}`
})
</script>

<template>
  <div class="flex min-h-screen bg-background">
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
    >{{ t('nav.skipToContent') }}</a>

    <!-- Drawer backdrop (below lg only) -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/50 lg:hidden"
      aria-hidden="true"
      @click="sidebarOpen = false"
    />

    <!-- Sidebar -->
    <aside
      v-show="sidebarOpen"
      :aria-label="t('nav.primary')"
      class="fixed inset-y-0 left-0 z-50 flex w-56 flex-col border-r border-border bg-card"
    >
      <!-- Logo -->
      <div class="flex h-14 items-center gap-2 border-b border-border px-4">
        <span class="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground" aria-hidden="true">K</span>
        <span class="text-base font-semibold tracking-tight">Koda</span>
      </div>

      <!-- Nav links -->
      <nav id="primary-nav" class="flex flex-1 flex-col overflow-y-auto px-3 pb-4 pt-2">
        <p :class="sectionLabelClass">{{ t('nav.sectionWorkspace') }}</p>
        <NuxtLink
          to="/"
          :class="navLinkClass"
          :active-class="activeClass"
          exact-active-class=""
        >
          <LayoutDashboard class="h-4 w-4 shrink-0" />
          {{ t('nav.dashboard') }}
        </NuxtLink>

        <NuxtLink to="/agents" :class="navLinkClass" :active-class="activeClass"><Bot class="h-4 w-4 shrink-0" />{{ t('nav.agents') }}</NuxtLink>

        <NuxtLink to="/admin/slos" :class="navLinkClass" :active-class="activeClass"><Activity class="h-4 w-4 shrink-0" />{{ t('nav.slos') }}</NuxtLink>

        <p v-if="isGlobalAdmin" :class="sectionLabelClass">{{ t('nav.sectionAdmin') }}</p>
        <NuxtLink v-if="isGlobalAdmin" to="/admin/users" :class="navLinkClass" :active-class="activeClass"><Users class="h-4 w-4 shrink-0" />{{ t('nav.users') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet" :class="navLinkClass" :active-class="activeClass"><Gauge class="h-4 w-4 shrink-0" />{{ t('nav.fleetOverview') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/runners" :class="navLinkClass" :active-class="activeClass"><Server class="h-4 w-4 shrink-0" />{{ t('nav.fleetRunners') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/repos" :class="navLinkClass" :active-class="activeClass"><FolderGit2 class="h-4 w-4 shrink-0" />{{ t('nav.fleetRepos') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/budgets" :class="navLinkClass" :active-class="activeClass"><Wallet class="h-4 w-4 shrink-0" />{{ t('nav.fleetBudgets') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/approvals" :class="navLinkClass" :active-class="activeClass"><Inbox class="h-4 w-4 shrink-0" />{{ t('nav.fleetApprovals') }}</NuxtLink>

        <NuxtLink v-if="isGlobalAdmin" to="/admin/fleet/analytics" :class="navLinkClass" :active-class="activeClass"><BarChart3 class="h-4 w-4 shrink-0" />{{ t('nav.fleetAnalytics') }}</NuxtLink>

        <!-- Project-scoped links: rendered after the global block in source, shown first via flex order -->
        <template v-if="projectSlug">
          <div class="order-first mb-1 flex flex-col border-b border-border pb-3">
            <p class="truncate px-2.5 pb-1 pt-3 text-sm font-semibold text-foreground" :title="projectSlug">{{ projectSlug }}</p>
            <p :class="sectionLabelClass">{{ t('nav.sectionWork') }}</p>
            <NuxtLink
              :to="`/${projectSlug}`"
              :class="navLinkClass"
              exact-active-class=""
              :active-class="activeClass"
            >
              <Kanban class="h-4 w-4 shrink-0" />
              {{ t('nav.board') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/labels`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Tag class="h-4 w-4 shrink-0" />
              {{ t('nav.labels') }}
            </NuxtLink>
            <p :class="sectionLabelClass">{{ t('nav.sectionKnowledge') }}</p>
            <NuxtLink
              :to="`/${projectSlug}/kb`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <BookOpen class="h-4 w-4 shrink-0" />
              {{ t('nav.kb') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/timeline`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Clock class="h-4 w-4 shrink-0" />
              {{ t('nav.timeline') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/memory`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Brain class="h-4 w-4 shrink-0" />
              {{ t('nav.memory') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/code-intel`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Code2 class="h-4 w-4 shrink-0" />
              {{ t('nav.codeIntel') }}
            </NuxtLink>
            <p :class="sectionLabelClass">{{ t('nav.sectionFleet') }}</p>
            <NuxtLink
              :to="`/${projectSlug}/fleet/overview`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Gauge class="h-4 w-4 shrink-0" />
              {{ t('nav.fleetOverview') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/fleet`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <Rocket class="h-4 w-4 shrink-0" />
              {{ t('nav.fleetJobs') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/fleet/analytics`"
              :class="navLinkClass"
              :active-class="activeClass"
            >
              <BarChart3 class="h-4 w-4 shrink-0" />
              {{ t('nav.fleetAnalytics') }}
            </NuxtLink>
            <NuxtLink
              :to="`/${projectSlug}/settings`"
              :class="[navLinkClass, 'mt-3']"
              :active-class="activeClass"
            >
              <Settings class="h-4 w-4 shrink-0" />
              {{ t('nav.settings') }}
            </NuxtLink>
          </div>
        </template>
      </nav>

      <!-- Sidebar footer: Language + Theme switchers -->
      <div class="flex items-center gap-2 border-t border-border px-3 py-3">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
    </aside>

    <!-- Main area -->
    <div class="flex min-w-0 flex-1 flex-col" :class="sidebarOpen ? 'lg:ml-56' : ''">
      <!-- Header -->
      <header class="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
        <div class="flex min-w-0 items-center gap-2">
          <Button
            id="sidebar-toggle"
            variant="ghost"
            size="sm"
            class="h-9 w-9 p-0"
            aria-controls="primary-nav"
            :aria-expanded="sidebarOpen ? 'true' : 'false'"
            @click="sidebarOpen = !sidebarOpen"
          >
            <span class="sr-only">{{ t('nav.toggleSidebar') }}</span>
            <Menu class="h-5 w-5" />
          </Button>

          <button
            type="button"
            class="flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground sm:w-64"
            @click="paletteOpen = true"
          >
            <Search class="h-4 w-4 shrink-0" />
            <span class="hidden flex-1 truncate text-left sm:inline">{{ t('palette.trigger') }}</span>
            <span class="sr-only sm:hidden">{{ t('palette.trigger') }}</span>
            <kbd class="hidden rounded border border-border bg-muted px-1.5 font-mono text-[11px] sm:inline">⌘K</kbd>
          </button>
        </div>

        <div class="flex items-center gap-3">
          <NotificationBell v-if="auth.user.value" />
          <FleetApprovalBadge v-if="auth.user.value" :key="projectSlug ?? ''" :slug="projectSlug ?? null" />
          <span class="hidden max-w-[16rem] truncate text-sm text-muted-foreground md:inline">
            {{ auth.user.value?.email }}
          </span>
          <Button
            variant="ghost"
            size="sm"
            @click="auth.logout()"
          >
            {{ t('common.logout') }}
          </Button>
        </div>
      </header>

      <!-- Breadcrumb bar -->
      <div
        v-if="breadcrumbItems.length > 1"
        class="flex items-center gap-2 border-b border-border px-4 py-2 sm:px-6"
      >
        <BackButton :to="backTo" />
        <AppBreadcrumb :items="breadcrumbItems" />
      </div>

      <!-- Page content -->
      <main id="main" tabindex="-1" class="px-4 py-4 sm:px-6">
        <slot />
      </main>
    </div>

    <CommandPalette v-if="auth.user.value" v-model:open="paletteOpen" :project-slug="projectSlug" />
  </div>
</template>
