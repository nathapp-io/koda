import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { actorKind, type KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { currentContext, runWithActionContext } from '../../action-context/action-context';
import { FLEET_PR_RULING_REPOSITORY, type IFleetPrRulingRepository, type CreateRulingInput, type FleetPrRuling } from './fleet-pr-ruling.domain';
import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';
import { GitHubAppClient } from '../git-broker/github-app-client';
import type { FleetRepoRef, FleetJobPrRulings } from '../jobs/domain/fleet-job.domain';
import { parseRulingText } from './ruling-keyword';

/** Sole ruling writer and eligibility boundary shared by REST and approved execution. */
@Injectable()
export class FleetPrRulingsService {
  constructor(
    @Inject(FLEET_PR_RULING_REPOSITORY) private readonly repo: IFleetPrRulingRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
    private readonly ticketEffects: FleetJobTicketEffects,
    private readonly github: GitHubAppClient,
  ) {}

  /** Dispatch-only, outside the insert transaction; forge failures never reject the FIX. */
  async snapshotForFix(repo: FleetRepoRef, prNumber: number): Promise<FleetJobPrRulings | undefined> {
    const runId = await this.latestRunForPr(repo.id, prNumber);
    if (!runId) return undefined;
    const pending = await this.repo.pendingForFix(runId);
    if (!pending.length) return undefined;
    try {
      if (repo.githubInstallationId === null) return { notSent: 'head-unreadable' };
      const { token } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name);
      const pr = await this.github.getPullRequest(token, repo.owner, repo.name, prNumber);
      if (!pr || pr.state !== 'open') return { notSent: 'pr-not-open' };
      if (!pr.headSha) return { notSent: 'head-unreadable' };
      return { headSha: pr.headSha, rulings: [...pending].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 100).map((r) => ({
        rulingId: r.id, item: r.itemId, ruling: r.text,
        by: `koda:${r.actorType === 'AGENT' ? 'agent' : 'user'}:${r.actorName}`.replace(/[\r\n\u2028\u2029]/g, '').slice(0, 100),
        at: r.createdAt.toISOString(),
      })) };
    } catch {
      // Deliberately do not log provider errors: they may contain the ephemeral credential.
      return { notSent: 'head-unreadable' };
    }
  }

  replaceOlderRuns(runJob: { id: string }): Promise<void> { return this.repo.replaceOlderRuns(runJob.id); }

  async ruleTarget(projectId: string, jobId: string, dto: CreateRulingInput) {
    const target = await this.repo.findTarget(projectId, jobId);
    if (!target) throw new NotFoundAppException({}, 'fleet.jobs');
    if (target.command !== 'RUN' || target.outcome !== 'draft' || target.prNumber === null) throw new ConflictAppException({}, 'fleet.rulings.notDraft');
    if (await this.latestRunForPr(target.repoId, target.prNumber) !== jobId) throw new ConflictAppException({}, 'fleet.rulings.notLatest');
    if (!target.openItems.some((item) => item.id === dto.itemId)) throw new NotFoundAppException({}, 'fleet.rulings.unknownItem');
    if (!parseRulingText(dto.text)) throw new ValidationAppException({ property: 'text' }, 'fleet.rulings.invalidText');
    if ((await this.repo.latestRuling(jobId, dto.itemId))?.state === 'applied') throw new ConflictAppException({}, 'fleet.rulings.settled');
    return target;
  }

  latestRunForPr(repoId: string, prNumber: number) { return this.repo.latestRunForPr(repoId, prNumber); }

  async list(projectId: string, jobId: string): Promise<FleetPrRuling[]> {
    if (!await this.repo.findTarget(projectId, jobId)) throw new NotFoundAppException({}, 'fleet.jobs');
    return this.repo.list(jobId);
  }

  async create(principal: KodaPrincipal, slug: string, jobId: string, dto: CreateRulingInput): Promise<FleetPrRuling> {
    const actorType = actorKind(principal) === 'agent' ? 'AGENT' : 'USER';
    const parsed = parseRulingText(dto.text);
    if (!parsed) throw new ValidationAppException({ property: 'text' }, 'fleet.rulings.invalidText');
    const context = currentContext();
    return runWithActionContext({ ...context, actor: { type: actorType, id: principal.id }, origin: context?.origin ?? 'rest' }, () => this.txManager.run(async () => {
      const target = await this.repo.lockTarget(slug, jobId);
      if (!target) throw new NotFoundAppException({}, 'fleet.jobs');
      // Preflight and approval replay checks are advisory until these transaction locks are held.
      // Re-read eligibility after waiting for any in-flight RUN/result/applied-state writer.
      await this.ruleTarget(target.projectId, jobId, dto);
      const item = target.openItems.find((item) => item.id === dto.itemId);
      if (!item) throw new NotFoundAppException({}, 'fleet.rulings.unknownItem');
      if (target.prNumber === null) throw new ValidationAppException({ property: 'jobId' }, 'fleet.rulings.invalidPr');
      const ticketId = await this.ticketEffects.ensureFinishTicket({ id: jobId }, principal);
      const comment = await this.ticketEffects.createRulingComment(ticketId, `${dto.itemId} (${item.kind}): ${dto.text.trim()}`, principal);
      await this.repo.replacePending(jobId, dto.itemId);
      const ruling = await this.repo.insert({
        projectId: target.projectId, repoId: target.repoId, prNumber: target.prNumber, jobId,
        itemId: dto.itemId, itemKind: item.kind, text: dto.text.trim(), disposition: parsed.disposition,
        actorType, actorId: principal.id, state: 'pending', skipReason: null, appliedJobId: null, commentId: comment.id,
        approvalRequestId: context?.approval.requestId ?? null,
      });
      await this.audit.record({ key: 'fleet.job.rule', resourceType: 'fleet_job', resourceId: jobId, projectId: target.projectId, summary: `ruled ${dto.itemId}: ${parsed.disposition}` });
      return ruling;
    }));
  }
}
