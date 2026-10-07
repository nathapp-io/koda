import type { ChipTone, CredentialKind } from '~/lib/fleet-capabilities'

/** Fleet S3 §4.4/§6: the admin credential board as `GET /fleet/credential-board` returns it. */
export const CELL_STATES = ['ok', 'expiring', 'expired', 'unavailable', 'missing'] as const
export type CellState = (typeof CELL_STATES)[number]
export interface BoardCell { state: CellState; kind: CredentialKind; expires?: string }
export interface BoardProfileNeeds { protocol: string; providers: string[]; sandbox: boolean }
export interface BoardProfileCell { present: boolean; needs?: BoardProfileNeeds; misfit?: string }
export interface BoardRunner { id: string; name: string; enabled: boolean; online: boolean; readable: boolean }
export interface CredentialBoard {
  generatedAt: string
  warnDays: number
  runners: BoardRunner[]
  providers: Array<{ providerId: string; cells: Record<string, BoardCell> }>
  profiles: Array<{ name: string; runners: Record<string, BoardProfileCell> }>
}

export const BOARD_PATH = '/fleet/credential-board'

const TONES: Record<CellState, ChipTone> = { ok: 'ok', expiring: 'warn', expired: 'warn', unavailable: 'bad', missing: 'bad' }

export function cellTone(state: CellState): ChipTone {
  return TONES[state] ?? 'bad'
}

export function cellLabelKey(state: string): string {
  return (CELL_STATES as readonly string[]).includes(state) ? `fleet.credentials.state.${state}` : 'fleet.credentials.state.unknown'
}

export function profileCellLabel(cell: BoardProfileCell | undefined): { key: string } {
  if (!cell) return { key: 'fleet.credentials.profiles.unknown' }
  if (!cell.present) return { key: 'fleet.credentials.profiles.absent' }
  return cell.misfit ? { key: `fleet.misfit.${cell.misfit}` } : { key: 'fleet.credentials.profiles.ready' }
}

const sameNeeds = (a: BoardProfileNeeds, b: BoardProfileNeeds): boolean =>
  a.protocol === b.protocol && a.sandbox === b.sandbox && [...a.providers].sort().join('\n') === [...b.providers].sort().join('\n')

export function rowNeeds(row: CredentialBoard['profiles'][number]): { needs: BoardProfileNeeds | null; differs: boolean } {
  const present = Object.values(row.runners).flatMap((c) => (c.present && c.needs ? [c.needs] : []))
  const first = present[0] ?? null
  return { needs: first, differs: first !== null && present.some((n) => !sameNeeds(first, n)) }
}
