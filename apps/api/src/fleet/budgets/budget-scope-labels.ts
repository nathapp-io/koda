import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { budgetScopeLabel } from '../../notifications/fleet/fleet-notification-events';
import type { BudgetScope, BudgetScopeType } from './domain/budget.domain';

/** Fleet S4a §2.4: a human label for a budget scope (project key, owner/name, runner name). */
@Injectable()
export class BudgetScopeLabels {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async forScope(scope: BudgetScope): Promise<string> {
    return budgetScopeLabel(scope.scopeType, scope.scopeId, await this.nameOf(scope));
  }

  async forPolicy(policyId: string): Promise<string | null> {
    const p = await this.db.budgetPolicy.findUnique({ where: { id: policyId }, select: { scopeType: true, scopeId: true } });
    return p ? this.forScope({ scopeType: p.scopeType as BudgetScopeType, scopeId: p.scopeId }) : null;
  }

  private async nameOf(scope: BudgetScope): Promise<string | null> {
    const id = scope.scopeId ?? '';
    switch (scope.scopeType) {
      case 'global': return null;
      case 'project': return (await this.db.project.findUnique({ where: { id }, select: { key: true } }))?.key ?? null;
      case 'repo': {
        const r = await this.db.fleetRepo.findUnique({ where: { id }, select: { owner: true, name: true } });
        return r ? `${r.owner}/${r.name}` : null;
      }
      case 'runner': return (await this.db.runner.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    }
  }
}
