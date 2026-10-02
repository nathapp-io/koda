import { Inject, Injectable } from '@nestjs/common';
import { PauseSnapshot } from './budget-rules';
import { BudgetPausedException } from './budget.exceptions';
import { BUDGET_REPOSITORY, IBudgetRepository } from './domain/budget.domain';

/** S1b §2.3 enforcement reads, shared by dispatch, requeue and placement. */
@Injectable()
export class BudgetGate {
  constructor(@Inject(BUDGET_REPOSITORY) private readonly repo: Pick<IBudgetRepository, 'findPaused'>) {}

  async snapshot(now: Date): Promise<PauseSnapshot> {
    return PauseSnapshot.of(await this.repo.findPaused(), now);
  }

  /** 409 fleet.budgetPaused when an effectively paused policy covers any of the keys. */
  async assertNotPaused(keys: readonly string[], now: Date): Promise<void> {
    const paused = (await this.snapshot(now)).match(keys);
    if (paused) throw new BudgetPausedException(paused);
  }
}
