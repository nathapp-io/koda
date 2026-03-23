<script setup lang="ts">
const { t } = useI18n()
const auth = useAuth()
const sidebarOpen = ref(true)
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
        <NuxtLink
          to="/"
          class="flex items-center rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {{ t('nav.dashboard') }}
        </NuxtLink>
        <NuxtLink
          to="/projects"
          class="flex items-center rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {{ t('nav.projects') }}
        </NuxtLink>
        <NuxtLink
          v-if="$route.params.project"
          :to="`/${$route.params.project}/agents`"
          class="flex items-center rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {{ t('nav.agents') }}
        </NuxtLink>
      </nav>

      <!-- Bottom user section -->
      <div class="border-t border-border p-4">
        <p class="truncate text-sm font-medium text-foreground">
          {{ auth.user.value?.email }}
        </p>
        <button
          class="mt-2 w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          @click="auth.logout()"
        >
          {{ t('common.logout') }}
        </button>
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
          <!-- Language switcher -->
          <LanguageSwitcher />

          <!-- Theme switcher -->
          <ThemeSwitcher />

          <!-- User dropdown -->
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

      <!-- Page content -->
      <main class="px-6 py-4">
        <slot />
      </main>
    </div>
  </div>
</template>
