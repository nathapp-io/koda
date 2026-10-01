<script setup lang="ts">
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { addToken, removeToken } from '~/lib/fleet-dispatch'

/** An ordered list of names (profile chain, labels): typed or picked from suggestions. */
const props = defineProps<{
  modelValue: string[]
  suggestions?: string[]
  placeholder?: string
  testId: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useI18n()

const draft = ref('')
const unused = computed(() => (props.suggestions ?? []).filter(s => !props.modelValue.includes(s)))

function add(token: string): void {
  emit('update:modelValue', addToken(props.modelValue, token))
  draft.value = ''
}

function remove(token: string): void {
  emit('update:modelValue', removeToken(props.modelValue, token))
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-2">
      <Badge v-for="(item, index) in modelValue" :key="item" variant="secondary" class="gap-1" :data-testid="`${testId}-item`">
        <span class="text-muted-foreground">{{ index + 1 }}.</span>
        {{ item }}
        <Button type="button" variant="ghost" size="icon" class="h-4 w-4" :aria-label="t('fleet.dispatch.remove', { item })" @click="remove(item)">
          <X class="h-3 w-3" />
        </Button>
      </Badge>
    </div>
    <div class="flex gap-2">
      <Input v-model="draft" :placeholder="placeholder" :data-testid="`${testId}-input`" @keydown.enter.prevent="add(draft)" />
      <Button type="button" variant="outline" :data-testid="`${testId}-add`" @click="add(draft)">{{ t('fleet.dispatch.add') }}</Button>
    </div>
    <div v-if="unused.length > 0" class="flex flex-wrap gap-2">
      <Button v-for="s in unused" :key="s" type="button" variant="ghost" size="sm" :data-testid="`${testId}-suggestion`" @click="add(s)">
        + {{ s }}
      </Button>
    </div>
  </div>
</template>
