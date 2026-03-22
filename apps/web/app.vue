<script setup lang="ts">
import { Toaster } from 'vue-sonner'
</script>

<template>
  <div class="min-h-screen bg-background">
    <nav class="border-b border-border bg-background">
      <div class="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div class="flex items-center justify-between">
          <h1 class="text-2xl font-bold">Koda</h1>
          <div class="flex items-center gap-4">
            <NuxtLink to="/" class="text-sm font-medium hover:text-muted-foreground">
              Projects
            </NuxtLink>
            <button
              class="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>

    <main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <NuxtPage />
    </main>

    <Toaster />
  </div>
</template>
