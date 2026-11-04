import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { actorKind, type KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { currentContext, runWithActionContext } from '../../action-context/action-context';
import { FLEET_PR_RULING_REPOSITORY, type IFleetPrRulingRepository, type CreateRulingInput, type FleetPrRuling } from './fleet-pr-ruling.domain';
import { parseRulingText } from './ruling-keyword';

/** Sole ruling creation writer. Route eligibility and approval checks join this core in US-004. */
@Injectable()
export class FleetPrRulingsService {
  constructor(
    @Inject(FLEET_PR_RULING_REPOSITORY) private readonly repo: IFleetPrRulingRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
  ) {}

  async create(principal: KodaPrincipal, slug: string, jobId: string, dto: CreateRulingInput): Promise<FleetPrRuling> {
    const actorType = actorKind(principal) === 'agent' ? 'AGENT' : 'USER';
    const parsed = parseRulingText(dto.text);
    if (!parsed) throw new ValidationAppException({ property: 'text' }, 'fleet.rulings.invalidText');
    const context = currentContext();
    return runWithActionContext({ ...context, actor: { type: actorType, id: principal.id }, origin: context?.origin ?? 'rest' }, () => this.txManager.run(async () => {
      const target = await this.repo.lockTarget(slug, jobId);
      if (!target) throw new NotFoundAppException({}, 'fleet.jobs');
      const item = target.openItems.find((item) => item.id === dto.itemId);
      if (!item) throw new NotFoundAppException({}, 'fleet.rulings.unknownItem');
      if (target.prNumber === null) throw new ValidationAppException({ property: 'jobId' }, 'fleet.rulings.invalidPr');
      await this.repo.replacePending(jobId, dto.itemId);
      const ruling = await this.repo.insert({
        projectId: target.projectId, repoId: target.repoId, prNumber: target.prNumber, jobId,
        itemId: dto.itemId, itemKind: item.kind, text: dto.text.trim(), disposition: parsed.disposition,
        actorType, actorId: principal.id, state: 'pending', skipReason: null, appliedJobId: null, commentId: null,
        approvalRequestId: context?.approval.requestId ?? null,
      });
      await this.audit.record({ key: 'fleet.job.rule', resourceType: 'fleet_job', resourceId: jobId, projectId: target.projectId, summary: `ruled ${dto.itemId}: ${parsed.disposition}` });
      return ruling;
    }));
  }
}
