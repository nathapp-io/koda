<script setup lang="ts">
import { ref } from 'vue'
import { handoffActionState, showActionBar } from '~/lib/thread-handoff'
import type { HandoffAction } from '~/lib/thread-handoff'
import type { ThreadHandoffBody } from '~/lib/thread-handoff-form'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'
const props=defineProps<{thread:ThreadDetailDto;messages:ChatMessageDto[];isCreator:boolean}>()
const emit=defineEmits<{(event:'publish'):void;(event:'plan',body:ThreadHandoffBody):void;(event:'run',body:ThreadHandoffBody):void}>()
const {t}=useI18n()
const publishOpen=ref(false), handoffOpen=ref(false)
const command=ref<'PLAN'|'RUN'>('PLAN')
const actions:HandoffAction[]=['publish','plan','run']
function openHandoff(value:'PLAN'|'RUN'){command.value=value;handoffOpen.value=true}
function onPublish(){publishOpen.value=false;emit('publish')}
function onSubmit(body:ThreadHandoffBody){handoffOpen.value=false;if(command.value==='PLAN')emit('plan',body);else emit('run',body)}
</script>
<template>
  <div v-if="showActionBar(props.thread,props.isCreator)" class="flex flex-wrap items-start gap-2" data-testid="thread-action-bar">
    <template v-for="action in actions" :key="action">
      <div class="flex flex-col gap-1">
        <Button :data-testid="`thread-action-${action}`" :disabled="!handoffActionState(props.thread,props.messages,action).enabled" :aria-describedby="handoffActionState(props.thread,props.messages,action).reason ? `thread-action-${action}-reason` : undefined" @click="action==='publish' ? publishOpen=true : openHandoff(action==='plan'?'PLAN':'RUN')">{{ t(`fleet.threads.handoff.actions.${action}`) }}</Button>
        <p v-if="handoffActionState(props.thread,props.messages,action).reason" :id="`thread-action-${action}-reason`" :data-testid="`thread-action-${action}-reason`" class="text-xs text-muted-foreground">{{ t(`fleet.threads.handoff.blocked.${handoffActionState(props.thread,props.messages,action).reason}`) }}</p>
      </div>
    </template>
    <FleetThreadsThreadPublishDialog :open="publishOpen" :paths="props.thread.writtenPaths" @update:open="publishOpen=$event" @confirm="onPublish" />
    <FleetThreadsThreadHandoffDialog :open="handoffOpen" :command="command" @update:open="handoffOpen=$event" @submit="onSubmit" />
  </div>
</template>
