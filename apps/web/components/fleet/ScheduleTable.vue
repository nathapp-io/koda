<template>
  <div class="overflow-x-auto" data-testid="fleet-schedules-table">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('fleet.schedules.table.name') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.target') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.cron') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.nextFire') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.status') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.table.owner') }}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="s in schedules"
          :key="s.id"
          :data-testid="`fleet-schedule-row-${s.id}`"
          :data-enabled="String(s.enabled)"
        >
          <TableCell>
            <NuxtLink :to="`/${slug}/fleet/schedules/${s.id}`" class="font-medium text-primary underline-offset-4 hover:underline" data-testid="fleet-schedule-link">{{ s.name }}</NuxtLink>
          </TableCell>
          <TableCell>
            <div>{{ repoName(s.repoId) }}</div>
            <div class="break-all text-xs text-muted-foreground">{{ s.feature }}</div>
          </TableCell>
          <TableCell>
            <div class="font-mono text-xs">{{ s.cron }}</div>
            <div class="text-xs text-muted-foreground">{{ s.timezone }}</div>
          </TableCell>
          <TableCell data-testid="fleet-schedule-next-fire">{{ formatInZone(s.nextFireAt, s.timezone) }}</TableCell>
          <TableCell>
            <Badge :variant="s.enabled ? 'default' : 'outline'" data-testid="fleet-schedule-status" :data-status="scheduleStatusKey(s)">
              {{ t(`fleet.schedules.status.${scheduleStatusKey(s)}`) }}
            </Badge>
          </TableCell>
          <TableCell>{{ ownerName(s.createdById) ?? t('fleet.schedules.detail.unknownOwner') }}</TableCell>
          <TableCell class="space-x-1 whitespace-nowrap text-right">
            <template v-if="canChangeSchedule(s, viewer)">
              <Button
                size="sm"
                variant="outline"
                :disabled="busy"
                :data-testid="s.enabled ? 'fleet-schedule-disable' : 'fleet-schedule-enable'"
                @click="$emit('toggle', s, !s.enabled)"
              >
                {{ s.enabled ? t('fleet.schedules.actions.disable') : t('fleet.schedules.actions.enable') }}
              </Button>
              <Button size="sm" variant="outline" :disabled="busy" data-testid="fleet-schedule-edit" @click="$emit('edit', s)">{{ t('fleet.schedules.actions.edit') }}</Button>
              <Button size="sm" variant="destructive" :disabled="busy" data-testid="fleet-schedule-delete" @click="$emit('remove', s)">{{ t('fleet.schedules.actions.delete') }}</Button>
            </template>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { canChangeSchedule, formatInZone, scheduleStatusKey } from '~/lib/fleet-schedules'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'

defineProps<{
  schedules: ScheduleDto[]
  slug: string
  viewer: ScheduleViewer
  repoName: (id: string) => string
  /** null for a former member. */
  ownerName: (id: string) => string | null
  busy: boolean
}>()

defineEmits<{
  (e: 'edit', schedule: ScheduleDto): void
  (e: 'toggle', schedule: ScheduleDto, enabled: boolean): void
  (e: 'remove', schedule: ScheduleDto): void
}>()

const { t } = useI18n()
</script>
