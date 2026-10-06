<template>
  <div class="flex min-h-screen items-center justify-center bg-background px-4">
    <div class="w-full max-w-md">
      <div class="mb-8 flex items-center justify-center gap-2.5">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground"
          aria-hidden="true"
        >
          K
        </span>
        <span class="text-lg font-semibold tracking-tight">Koda</span>
      </div>
      <Card class="w-full max-w-md">
        <CardContent class="pt-6">
          <slot />
        </CardContent>
      </Card>
    </div>
  </div>
</template>

<script setup lang="ts">
</script>
