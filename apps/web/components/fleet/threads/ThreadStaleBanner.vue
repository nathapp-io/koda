<script setup lang="ts">
import { computed, ref } from 'vue'
import { handoffActionState, showStaleBanner } from '~/lib/thread-handoff'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'
const props=defineProps<{thread:ThreadDetailDto;messages:ChatMessageDto[];isCreator:boolean}>()
const emit=defineEmits<{(event:'discard'):void}>()
const {t}=useI18n()
const confirmOpen=ref(false)
const state=computed(()=>handoffActionState(props.thread,props.messages,'discard'))
function confirm(){confirmOpen.value=false;emit('discard')}
</script>
<template>
  <section v-if="showStaleBanner(props.thread)" class="rounded-md border border-border p-3" data-testid="thread-stale-banner">
    <h2>{{ t('fleet.threads.handoff.stale.title') }}</h2><p>{{ t('fleet.threads.handoff.stale.body') }}</p>
    <template v-if="props.isCreator"><Button data-testid="thread-stale-discard" :disabled="!state.enabled" @click="confirmOpen=true">{{ t('fleet.threads.handoff.actions.discard') }}</Button><span v-if="state.reason">{{ t(`fleet.threads.handoff.blocked.${state.reason}`) }}</span></template>
    <Dialog :open="confirmOpen" @update:open="confirmOpen=$event"><DialogContent v-if="confirmOpen"><DialogHeader><DialogTitle>{{ t('fleet.threads.handoff.discardDialog.title') }}</DialogTitle></DialogHeader><p>{{ t('fleet.threads.handoff.discardDialog.body') }}</p><DialogFooter><Button data-testid="thread-discard-confirm" @click="confirm">{{ t('fleet.threads.handoff.discardDialog.confirm') }}</Button></DialogFooter></DialogContent></Dialog>
  </section>
</template>
