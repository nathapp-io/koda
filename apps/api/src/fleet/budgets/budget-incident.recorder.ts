import { Injectable } from '@nestjs/common';
import { OutboxService } from '@nathapp/nestjs-outbox';
import {
  budgetIncidentId, BudgetIncidentNotifyKind, FLEET_BUDGET_INCIDENT, FleetBudgetIncidentPayload,
} from '../../notifications/fleet/fleet-notification-events';
import { BudgetScopeLabels } from './budget-scope-labels';
import type { BudgetPolicyRecord } from './domain/budget.domain';

/**
 * Fleet S4a §2.4 (D508): the enqueue side of `fleet_budget_incident`. Called by BudgetEvaluator right after
 * insertIncident inserted a warn or hard_stop row, inside evaluate's transaction under the policy lock.
 * A global policy has no project (D512).
 */
@Injectable()
export class BudgetIncidentRecorder {
  constructor(
    private readonly labels: BudgetScopeLabels,
    private readonly outbox: OutboxService,
  ) {}

  async record(policy: BudgetPolicyRecord, kind: BudgetIncidentNotifyKind, windowStart: Date, spentUsd: string): Promise<void> {
    const incidentId = budgetIncidentId(policy.id, kind, windowStart, policy.amountUsd);
    const payload: FleetBudgetIncidentPayload = {
      incidentId, kind, scope: await this.labels.forScope(policy), spentUsd, amountUsd: policy.amountUsd,
    };
    await this.outbox.record({ type: FLEET_BUDGET_INCIDENT, payload, metadata: { projectId: policy.projectId, eventId: incidentId } });
  }
}
