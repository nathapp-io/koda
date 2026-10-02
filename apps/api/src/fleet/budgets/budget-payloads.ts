import type { BudgetPolicyRecord } from './domain/budget.domain';

/**
 * FleetActivity payload of a budget row. Never a `*Key` field: FleetActivityService rejects key-like names
 * (`/token|secret|key|password|credential/i`), so the scope is scopeType + scopeId.
 */
export function budgetActivityPayload(p: BudgetPolicyRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scopeType: p.scopeType, scopeId: p.scopeId, windowKind: p.windowKind, amountUsd: p.amountUsd, ...extra };
}

/** Body of the fleet.budget.warn and fleet.budget.hard_stop webhooks (S1b §4). */
export function budgetWebhookPayload(p: BudgetPolicyRecord, spentUsd: string, windowStart: Date): Record<string, unknown> {
  return {
    policyId: p.id, scopeType: p.scopeType, scopeId: p.scopeId, projectId: p.projectId, windowKind: p.windowKind,
    windowStart: windowStart.toISOString(), amountUsd: p.amountUsd, warnPercent: p.warnPercent, spentUsd,
  };
}
