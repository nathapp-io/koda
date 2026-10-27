import { AppException } from '@nathapp/nestjs-common';
import type { BudgetRoute } from '../budgets/budgets.service';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';

/**
 * Plan D229: the budgets service's ownership route follows the policy's scope, not the request prefix.
 * Shared by the fleet decide path and the budget command (permissions P3 US-005), so the two cannot
 * disagree about which route owns a policy.
 */
export const budgetRouteOf = (p: BudgetPolicyRecord): BudgetRoute =>
  p.projectId && (p.scopeType === 'project' || p.scopeType === 'repo') ? { kind: 'project', projectId: p.projectId } : { kind: 'admin' };

/**
 * Plan D233: `error` is an i18n coordinate, not free text. `HttpException.initMessage()` falls back to the
 * class name when the response object carries no `message`, so `error.message` stores "Conflict App
 * Exception" and loses the args that say why (a duplicate active job's `activeJobId`); anything else, a
 * Prisma failure included, would store raw internal text into a persisted column. `args` are exactly the
 * values the exception handler interpolates into the user-facing message, so this discloses nothing new.
 */
export const errorText = (error: unknown): string =>
  error instanceof AppException ? JSON.stringify({ code: error.prefix, args: error.args }) : 'unexpected error';
