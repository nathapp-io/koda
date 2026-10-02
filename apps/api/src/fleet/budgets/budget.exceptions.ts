import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { BudgetPolicyRecord } from './domain/budget.domain';

/** S1b §2.3: 409 fleet.budgetPaused. The args reach the client through the message (plan D154). */
export class BudgetPausedException extends ConflictAppException {
  constructor(policy: Pick<BudgetPolicyRecord, 'id' | 'scopeType' | 'scopeId' | 'scopeKey'>) {
    super({ policyId: policy.id, scopeType: policy.scopeType, scopeId: policy.scopeId ?? '', scope: policy.scopeKey }, 'fleet.budgetPaused');
  }
}
