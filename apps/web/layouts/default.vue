<script setup lang="ts">
import { LayoutDashboard, Kanban, Bot, Tag, BookOpen } from 'lucide-vue-next'

const { t } = useI18n()
const auth = useAuth()
const route = useRoute()
const sidebarOpen = ref(true)

const projectSlug = computed(() => route.params.project as string | undefined)

const navLinkClass =
  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors'
const activeClass = 'bg-accent text-accent-foreground'

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
    <!-- Sidebar -->
    <aside
      v-show="sidebarOpen"
      class="fixed inset-y-0 left-0 z-50 flex w-56 flex-col border-r border-border bg-background"
    >
      <!-- Logo -->
      <div class="flex h-16 items-center border-b border-border px-4">
        <span class="text-xl font-bold">Koda</span>
      </div>

      <!-- Nav links -->
      <nav class="flex-1 space-y-1 px-3 py-4">
        <!-- Always visible: Dashboard + Agents -->
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

        <!-- Project-scoped links -->
        <template v-if="projectSlug">
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
          <NuxtLink
            :to="`/${projectSlug}/kb`"
            :class="navLinkClass"
            :active-class="activeClass"
          >
            <BookOpen class="h-4 w-4 shrink-0" />
            {{ t('nav.kb') }}
          </NuxtLink>
        </template>
      </nav>

      <!-- Sidebar footer: Language + Theme switchers -->
      <div class="flex items-center gap-2 border-t border-border px-3 py-3">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
    </aside>

    <!-- Main area -->
    <div class="flex flex-1 flex-col" :class="sidebarOpen ? 'ml-56' : ''">
      <!-- Header -->
      <header class="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-border bg-background px-6">
        <button
          class="rounded-md p-2 hover:bg-accent"
          @click="sidebarOpen = !sidebarOpen"
        >
          <span class="sr-only">{{ t('nav.toggleSidebar') }}</span>
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div class="flex items-center gap-4">
          <span class="text-sm font-medium text-foreground">
            {{ auth.user.value?.email }}
          </span>
          <button
            class="rounded-md px-3 py-2 text-sm font-medium hover:bg-accent"
            @click="auth.logout()"
          >
            {{ t('common.logout') }}
          </button>
        </div>
      </header>

      <!-- Breadcrumb bar -->
      <div
        v-if="breadcrumbItems.length > 1"
        class="flex items-center gap-2 border-b border-border px-6 py-2"
      >
        <BackButton :to="backTo" />
        <AppBreadcrumb :items="breadcrumbItems" />
      </div>

      <!-- Page content -->
      <main class="px-6 py-4">
        <slot />
      </main>
    </div>
  </div>
</template>
