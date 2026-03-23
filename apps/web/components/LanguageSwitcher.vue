<script setup lang="ts">
const { locale, locales, setLocale } = useI18n()

const allLocales = computed(() =>
  (locales.value as Array<{ code: string; name: string }>).filter(
    (l) => typeof l !== 'string'
  )
)

const currentLocaleName = computed(() => {
  const current = allLocales.value.find((l) => l.code === locale.value)
  return current?.name ?? locale.value
})

function switchLocale(code: string) {
  setLocale(code)
}
</script>

<template>
  <div class="flex items-center gap-1">
    <button
      v-for="loc in allLocales"
      :key="loc.code"
      :class="[
        'px-2 py-1 text-xs rounded transition-colors',
        locale === loc.code
          ? 'bg-primary text-primary-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      ]"
      @click="switchLocale(loc.code)"
    >
      {{ loc.name }}
    </button>
  </div>
</template>
