<template>
  <div v-if="state" class="flex items-center gap-2">
    <Button
      size="sm"
      variant="outline"
      :disabled="busy"
      :aria-pressed="state.watching ? 'true' : 'false'"
      data-testid="ticket-watch-toggle"
      @click="onToggle"
    >
      <EyeOff v-if="state.watching" class="mr-1.5 h-4 w-4" />
      <Eye v-else class="mr-1.5 h-4 w-4" />
      {{ state.watching ? t('notifications.watch.unwatch') : t('notifications.watch.watch') }}
    </Button>
    <span class="text-xs text-muted-foreground" data-testid="ticket-watch-count">
      {{ t('notifications.watch.count', { count: state.count }) }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { Eye, EyeOff } from 'lucide-vue-next'
import { useTicketWatch } from '~/composables/useTicketWatch'

/** Fleet S4a §5: watch or mute one ticket. Unwatch is sticky; assignment and @mentions still notify (D502). */
const props = defineProps<{ projectSlug: string; ticketRef: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { state, busy, load, toggle } = useTicketWatch(props.projectSlug, props.ticketRef)

onMounted(async () => {
  try {
    await load()
  } catch {
    // No button: watching is optional and the ticket page must stay usable.
  }
})

async function onToggle(): Promise<void> {
  try {
    await toggle()
  } catch {
    toast.error(t('notifications.watch.failed'))
  }
}
</script>
