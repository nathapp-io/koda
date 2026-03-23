<script setup lang="ts">
const { locale, locales, setLocale } = useI18n()

const availableLocales = computed(() =>
  (locales.value as Array<{ code: string; name: string }>).filter(
    (l) => typeof l !== 'string'
  )
)

const currentLocaleName = computed(() => {
  const current = availableLocales.value.find((l) => l.code === locale.value)
  return current?.name ?? locale.value
})

function switchLocale(code: string) {
  setLocale(code)
}
</script>

<template>
  <Select :model-value="locale" @update:model-value="switchLocale">
    <SelectTrigger class="w-[110px] h-8 text-xs">
      <span>{{ currentLocaleName }}</span>
    </SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="loc in availableLocales"
        :key="loc.code"
        :value="loc.code"
      >
        {{ loc.name }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
