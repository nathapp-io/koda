import type { ApprovalMode } from '../../permissions/catalog';

export const APPROVAL_MODE_RANK: Readonly<Record<ApprovalMode, number>> = { none: 0, self: 1, agent: 2, human: 3 };

export function modeAtLeast(mode: ApprovalMode, required: ApprovalMode): boolean {
  return APPROVAL_MODE_RANK[mode] >= APPROVAL_MODE_RANK[required];
}

export function strictestMode(...modes: ApprovalMode[]): ApprovalMode {
  return modes.reduce<ApprovalMode>((strictest, mode) => modeAtLeast(mode, strictest) ? mode : strictest, 'none');
}
