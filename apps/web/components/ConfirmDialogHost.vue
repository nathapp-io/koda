<script setup lang="ts">
const { t } = useI18n()
const { current, settle } = useConfirm()
</script>

<template>
  <Dialog :open="current !== null" @update:open="(open: boolean) => { if (!open) settle(false) }">
    <DialogContent v-if="current" data-testid="confirm-dialog">
      <DialogHeader>
        <DialogTitle>{{ current.title }}</DialogTitle>
      </DialogHeader>
      <p v-if="current.body" data-testid="confirm-dialog-body" class="text-sm text-muted-foreground">{{ current.body }}</p>
      <DialogFooter>
        <Button type="button" variant="outline" data-testid="confirm-dialog-cancel" @click="settle(false)">
          {{ t('common.cancel') }}
        </Button>
        <Button
          type="button"
          :variant="current.destructive ? 'destructive' : 'default'"
          data-testid="confirm-dialog-confirm"
          @click="settle(true)"
        >{{ current.confirmLabel ?? t('common.confirm') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
