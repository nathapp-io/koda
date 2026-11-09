import { Prisma } from '../../generated/prisma/client';
import { TERMINAL_STATES } from '../jobs/job-state';
import type { FlowJobRow } from './domain/fleet-flow-step.domain';

export const UNKNOWN_COST_COMMANDS: readonly string[] = ['AGENT', 'PLAN', 'REVIEW', 'FIX'];

export function totalCostUsd(row: FlowJobRow): string {
  return new Prisma.Decimal(row.costSpentUsd).add(new Prisma.Decimal(row.costCarriedUsd)).toFixed(4);
}

export function countUnknownCost(rows: FlowJobRow[]): number {
  const terminalStates: readonly string[] = TERMINAL_STATES;
  return rows.filter((row) =>
    UNKNOWN_COST_COMMANDS.includes(row.command)
    && terminalStates.includes(row.state)
    && new Prisma.Decimal(row.costSpentUsd).add(new Prisma.Decimal(row.costCarriedUsd)).isZero(),
  ).length;
}
