<script setup lang="ts">
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { locale, locales, setLocale } = useI18n() as any;

const allLocales = computed(() =>
  (locales.value as Array<{ code: string; name: string }>).filter(
    (l) => typeof l !== 'string'
  )
)

const currentLocaleName = computed(() => {
  const current = allLocales.value.find((l) => l.code === locale.value)
  return current?.name ?? locale.value
})

const useDropdown = computed(() => allLocales.value.length > 2)

function switchLocale(code: string) {
  setLocale(code)
}
</script>

<template>
  <!-- Toggle buttons for 2 locales -->
  <div v-if="!useDropdown" class="flex items-center gap-1">
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

  <!-- Select dropdown for 3+ locales -->
  <Select v-else :model-value="locale" @update:model-value="switchLocale">
    <SelectTrigger class="w-[110px] h-8 text-xs">
      <span>{{ currentLocaleName }}</span>
    </SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="loc in allLocales"
        :key="loc.code"
        :value="loc.code"
      >
        {{ loc.name }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
