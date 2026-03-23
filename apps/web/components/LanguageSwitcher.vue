<script setup lang="ts">
const { locale, locales, setLocale } = useI18n()

const availableLocales = computed(() =>
  (locales.value as Array<{ code: string; name: string }>).filter(
    (l) => typeof l !== 'string'
  )
)

function switchLocale(code: string) {
  setLocale(code)
}
</script>

<template>
  <Select :model-value="locale" @update:model-value="switchLocale">
    <SelectTrigger class="w-[100px] h-8 text-xs">
      <SelectValue />
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
