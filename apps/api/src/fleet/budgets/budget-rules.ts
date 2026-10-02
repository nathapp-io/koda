import { Prisma } from '@prisma/client';
import type { BudgetPolicyRecord, BudgetScopeType, BudgetWindowKind } from './domain/budget.domain';

/** Plan D155: the lifetime window's start, stored in incidents and in pausedWindowStart. */
export const LIFETIME_WINDOW_START = new Date(0);

/** S1b §2.1: the first instant of the current UTC month, or the epoch for lifetime. */
export function windowStart(kind: BudgetWindowKind, now: Date): Date {
  return kind === 'lifetime' ? LIFETIME_WINDOW_START : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The `firstStartedAt` lower bound of a window spend query; null = no bound (lifetime). */
export function spendSince(kind: BudgetWindowKind, now: Date): Date | null {
  return kind === 'lifetime' ? null : windowStart(kind, now);
}

export function scopeKeyOf(scopeType: BudgetScopeType, scopeId: string | null): string {
  return scopeType === 'global' ? 'global' : `${scopeType}:${scopeId}`;
}

/** The stateReason and cancelReason of a budget stop. */
export const budgetReason = (policyId: string): string => `budget:${policyId}`;

type PauseFields = Pick<BudgetPolicyRecord, 'windowKind' | 'pausedAt' | 'pausedWindowStart'>;

/** S1b §2.3: a stale monthly pause (an earlier window) is not enforced, even before the sweep clears it. */
export function isEffectivelyPaused(p: PauseFields, now: Date): boolean {
  if (!p.pausedAt) return false;
  if (p.windowKind === 'lifetime') return true;
  return p.pausedWindowStart !== null && p.pausedWindowStart.getTime() === windowStart(p.windowKind, now).getTime();
}

/** B8: a monthly pause from an earlier window; the sweep clears it. */
export function isStaleMonthlyPause(p: PauseFields, now: Date): boolean {
  return p.windowKind === 'calendar_month_utc' && p.pausedAt !== null && p.pausedWindowStart !== null &&
    p.pausedWindowStart.getTime() < windowStart(p.windowKind, now).getTime();
}

/** S1b §2.3: the scopes that gate a job, in precedence order (the pinned runner last). */
export function jobGateKeys(job: { projectId: string; repoId: string; pinnedRunnerId: string | null }): string[] {
  return ['global', `project:${job.projectId}`, `repo:${job.repoId}`, ...(job.pinnedRunnerId ? [`runner:${job.pinnedRunnerId}`] : [])];
}

/** S1b §2.2: the scopes whose window spend a job's cost change moves (its current runner, not the pin). */
export function jobSpendKeys(job: { projectId: string; repoId: string; runnerId: string | null }): string[] {
  return ['global', `project:${job.projectId}`, `repo:${job.repoId}`, ...(job.runnerId ? [`runner:${job.runnerId}`] : [])];
}

export function warnReached(spent: string, amount: string, warnPercent: number | null): boolean {
  if (warnPercent === null) return false;
  // spent >= amount * pct / 100, multiplied out so no division is ever rounded.
  return new Prisma.Decimal(spent).mul(100).gte(new Prisma.Decimal(amount).mul(warnPercent));
}

export function hardReached(spent: string, amount: string): boolean {
  return new Prisma.Decimal(spent).gte(amount);
}

export function isAboveSpend(amount: string, spent: string): boolean {
  return new Prisma.Decimal(amount).gt(spent);
}

/** Plan D158: the effectively paused policies, read once per placement or dispatch check. */
export class PauseSnapshot {
  private constructor(private readonly paused: readonly BudgetPolicyRecord[]) {}

  static of(policies: readonly BudgetPolicyRecord[], now: Date): PauseSnapshot {
    return new PauseSnapshot(policies.filter((p) => isEffectivelyPaused(p, now)));
  }

  /** The paused policy of the first key that has one, in the keys' order. */
  match(keys: readonly string[]): BudgetPolicyRecord | null {
    for (const key of keys) {
      const hit = this.paused.find((p) => p.scopeKey === key);
      if (hit) return hit;
    }
    return null;
  }

  runnerPaused(runnerId: string): boolean {
    return this.paused.some((p) => p.scopeKey === `runner:${runnerId}`);
  }
}
