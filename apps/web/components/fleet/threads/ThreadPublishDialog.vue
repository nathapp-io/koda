<script setup lang="ts">
const props = defineProps<{ open: boolean; paths: string[] }>()
const emit = defineEmits<{ (event:'update:open', value:boolean):void; (event:'confirm'):void }>()
const { t } = useI18n()
</script>
<template>
  <Dialog :open="props.open" @update:open="emit('update:open',$event)">
    <DialogContent v-if="props.open">
      <DialogHeader><DialogTitle>{{ t('fleet.threads.handoff.publishDialog.title') }}</DialogTitle></DialogHeader>
      <ul><li v-for="path in props.paths" :key="path" data-testid="thread-publish-path">{{ path }}</li></ul>
      <!-- An ask/full turn edits the worktree through the agent's own tools, so it has no write_doc paths to list. -->
      <p v-if="props.paths.length === 0" class="text-sm text-muted-foreground" data-testid="thread-publish-no-paths">{{ t('fleet.threads.handoff.publishDialog.noPaths') }}</p>
      <DialogFooter><Button type="button" data-testid="thread-publish-confirm" @click="emit('confirm')">{{ t('fleet.threads.handoff.publishDialog.confirm') }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>
