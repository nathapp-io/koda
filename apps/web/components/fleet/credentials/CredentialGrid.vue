<script setup lang="ts">
import type { ChipTone } from '~/lib/fleet-capabilities'
import { cellLabelKey, cellTone, kodaKeyFor } from '~/lib/fleet-credential-board'
import type { BoardCell, CredentialBoard, KodaKey } from '~/lib/fleet-credential-board'

/**
 * Fleet S3 §6: providers x runners; a runner with unreadable capabilities has no cells. C10 US-007
 * added the koda column (the GLOBAL key koda holds for that provider) and the per-runner "vault off"
 * marker, which is a runner capability, not a credential state.
 */
const props = defineProps<{ board: CredentialBoard }>()
const { t } = useI18n()

function variantOf(tone: ChipTone): 'secondary' | 'outline' | 'destructive' {
  if (tone === 'bad') return 'destructive'
  return tone === 'warn' ? 'outline' : 'secondary'
}

function cellText(cell: BoardCell): string {
  const state = t(cellLabelKey(cell.state))
  const kind = t(`fleet.runners.chip.kind.${cell.kind}`)
  const until = cell.expires ? ` ${t('fleet.credentials.grid.expires', { date: cell.expires.slice(0, 10) })}` : ''
  return cell.state === 'missing' ? state : `${state} · ${kind}${until}`
}

function kodaKey(providerId: string): KodaKey | undefined {
  return kodaKeyFor(props.board, providerId)
}
</script>

<template>
  <Table data-testid="fleet-credentials-grid">
    <TableHeader>
      <TableRow>
        <TableHead>{{ t('fleet.credentials.grid.provider') }}</TableHead>
        <TableHead data-testid="fleet-credentials-koda-head">{{ t('fleet.credentials.grid.koda') }}</TableHead>
        <TableHead
          v-for="runner in board.runners"
          :key="runner.id"
          data-testid="fleet-credentials-runner-head"
          :data-runner="runner.id"
          :data-dimmed="!runner.online || !runner.enabled ? 'true' : 'false'"
          :class="!runner.online || !runner.enabled ? 'opacity-60' : ''"
        >
          <div class="font-medium">{{ runner.name }}</div>
          <div v-if="!runner.readable" class="text-xs text-muted-foreground">{{ t('fleet.credentials.grid.unreadable') }}</div>
          <div v-if="!runner.providerVault" class="text-xs text-muted-foreground" data-testid="fleet-credentials-vault-off">{{ t('fleet.credentials.grid.vaultOff') }}</div>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow
        v-for="row in board.providers"
        :key="row.providerId"
        data-testid="fleet-credentials-row"
        :data-provider="row.providerId"
      >
        <TableCell class="font-medium">{{ row.providerId }}</TableCell>
        <TableCell data-testid="fleet-credentials-koda" :data-provider="row.providerId">
          <template v-if="kodaKey(row.providerId)">
            <span class="font-medium">{{ kodaKey(row.providerId)?.name }}</span>
            <span class="text-xs text-muted-foreground"> · {{ kodaKey(row.providerId)?.last4 }}</span>
          </template>
          <span v-else class="text-muted-foreground">-</span>
        </TableCell>
        <TableCell
          v-for="runner in board.runners"
          :key="runner.id"
          data-testid="fleet-credentials-cell"
          :data-provider="row.providerId"
          :data-runner="runner.id"
          :data-state="row.cells[runner.id]?.state ?? 'none'"
        >
          <Badge v-if="row.cells[runner.id]" :variant="variantOf(cellTone(row.cells[runner.id].state))">{{ cellText(row.cells[runner.id]) }}</Badge>
          <span v-else class="text-muted-foreground">-</span>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
