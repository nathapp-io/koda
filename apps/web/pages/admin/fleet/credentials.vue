<script setup lang="ts">
import { onMounted } from 'vue'
import { useFleetCredentialBoard } from '~/composables/useFleetCredentialBoard'

definePageMeta({ layout: 'default' })

/** Fleet S3 §6: provider credentials and profiles on every runner (global admin; others see the 403 note). */
const { t } = useI18n()
const { data, pending, forbidden, failed, load } = useFleetCredentialBoard()

onMounted(() => { void load() })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.credentials.title')" :subtitle="t('fleet.credentials.subtitle', { days: data?.warnDays ?? 7 })">
      <template #actions>
        <Button variant="outline" :disabled="pending || forbidden" data-testid="fleet-credentials-refresh" @click="load()">
          {{ t('fleet.credentials.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-credentials-forbidden">{{ t('fleet.common.adminOnly') }}</p>
    <template v-else>
      <ErrorState v-if="failed && !data" @retry="load()" />
      <LoadingState v-else-if="!data" />
      <EmptyState v-else-if="data.runners.length === 0" :message="t('fleet.credentials.empty')" />
      <Tabs v-else default-value="grid">
        <TabsList>
          <TabsTrigger value="grid" data-testid="fleet-credentials-tab-grid">{{ t('fleet.credentials.tabs.grid') }}</TabsTrigger>
          <TabsTrigger value="profiles" data-testid="fleet-credentials-tab-profiles">{{ t('fleet.credentials.tabs.profiles') }}</TabsTrigger>
        </TabsList>
        <TabsContent value="grid" class="overflow-x-auto">
          <FleetCredentialsCredentialGrid :board="data" />
        </TabsContent>
        <TabsContent value="profiles" class="overflow-x-auto">
          <FleetCredentialsProfileInventory :board="data" />
        </TabsContent>
      </Tabs>
    </template>
  </div>
</template>
