<script setup lang="ts">
import { profileCellLabel, rowNeeds } from '~/lib/fleet-credential-board'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

/** Fleet S3 §6: every profile any runner reports, what it needs, and whether each runner can serve it. */
defineProps<{ board: CredentialBoard }>()
const { t } = useI18n()

function needsText(row: CredentialBoard['profiles'][number]): string {
  const { needs, differs } = rowNeeds(row)
  if (!needs) return '-'
  const base = t('fleet.credentials.profiles.needsValue', { protocol: needs.protocol, providers: needs.providers.join(', ') || '-' })
  const sandbox = needs.sandbox ? ` · ${t('fleet.credentials.profiles.sandbox')}` : ''
  const note = differs ? ` (${t('fleet.credentials.profiles.differs')})` : ''
  return `${base}${sandbox}${note}`
}
</script>

<template>
  <Table data-testid="fleet-credentials-profiles">
    <TableHeader>
      <TableRow>
        <TableHead>{{ t('fleet.credentials.profiles.profile') }}</TableHead>
        <TableHead>{{ t('fleet.credentials.profiles.needs') }}</TableHead>
        <TableHead v-for="runner in board.runners" :key="runner.id" :class="!runner.online || !runner.enabled ? 'opacity-60' : ''">
          {{ runner.name }}
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="row in board.profiles" :key="row.name" data-testid="fleet-credentials-profile-row" :data-profile="row.name">
        <TableCell class="font-medium">{{ row.name }}</TableCell>
        <TableCell class="text-sm">{{ needsText(row) }}</TableCell>
        <TableCell
          v-for="runner in board.runners"
          :key="runner.id"
          data-testid="fleet-credentials-profile-cell"
          :data-profile="row.name"
          :data-runner="runner.id"
          :data-misfit="row.runners[runner.id]?.misfit ?? ''"
        >
          <Badge
            v-if="row.runners[runner.id]?.present"
            :variant="row.runners[runner.id]?.misfit ? 'destructive' : 'secondary'"
          >{{ t(profileCellLabel(row.runners[runner.id]).key) }}</Badge>
          <span v-else class="text-muted-foreground">{{ t(profileCellLabel(row.runners[runner.id]).key) }}</span>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
