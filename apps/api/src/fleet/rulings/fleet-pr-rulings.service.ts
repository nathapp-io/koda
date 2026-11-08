import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { actorKind, type KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { currentContext, runWithActionContext } from '../../action-context/action-context';
import { FLEET_PR_RULING_REPOSITORY, type IFleetPrRulingRepository, type CreateRulingInput, type FleetPrRuling, type RulingJobTarget } from './fleet-pr-ruling.domain';
import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';
import { GitHubAppClient } from '../git-broker/github-app-client';
import type { FleetRepoRef, FleetJobPrRulings, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { parseRulingText } from './ruling-keyword';
import type { BotReviewParse } from '../ingest/parsers/bot-review.parser';
import { prNumberOfReviewFeature } from '../common/review-jobs';

/** #394: the marker nax publishes in a PR comment once it has an item index for the review. */
export const NAX_ITEM_INDEX_MARKER = '<!-- nax-bot:v1 key=w-index -->';
/** One comments page: a full page means a marker may sit beyond the page we read, so the check fails open. */
const ITEM_INDEX_COMMENT_PAGE = 100;

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
      // Reading a PR needs pull_requests:read; the contents-only read token gets a 403 on a private repo.
      const { token } = await this.github.mintThreadReadToken(repo.githubInstallationId, repo.name);
      const pr = await this.github.getPullRequest(token, repo.owner, repo.name, prNumber);
      if (!pr || pr.state !== 'open') return { notSent: 'pr-not-open' };
      if (!pr.headSha) return { notSent: 'head-unreadable' };
      return { headSha: pr.headSha, rulings: [...pending].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 100).map((r) => ({
        rulingId: r.id, item: r.itemId, ruling: r.text,
        by: `koda:${r.actorType === 'AGENT' ? 'agent' : r.actorType === 'SYSTEM' ? 'system' : 'user'}:${r.actorType === 'SYSTEM' ? r.actorId : r.actorName}`.replace(/[\r\n\u2028\u2029]/g, '').slice(0, 100),
        at: r.createdAt.toISOString(),
      })) };
    } catch {
      // Deliberately do not log provider errors: they may contain the ephemeral credential.
      return { notSent: 'head-unreadable' };
    }
  }

  /** Ingest owns the transaction, terminal-state/epoch fence and FIX job lock. */
  async recordResults(job: Pick<FleetJobRecord, 'id' | 'repoId' | 'feature' | 'prRulings' | 'fixReady'>, parse: BotReviewParse): Promise<void> {
    const caller = parse.outcome === 'done' ? parse.callerRulings : undefined;
    const snapshot = job.prRulings;
    const summaries = new Map<string, { applied: string[]; skipped: string[] }>();
    if (caller && caller.ignored !== 'head-mismatch' && snapshot && 'rulings' in snapshot) {
      for (const sent of snapshot.rulings) {
        const applied = caller.applied.find((entry) => entry.item === sent.item);
        const skipped = caller.skipped.find((entry) => entry.item === sent.item);
        const reason = caller.ignored === 'untrusted-pr' ? 'untrusted-pr' : applied ? null : skipped?.reason;
        if (reason === undefined || reason === 'echo-failed' || reason === 'recorder-failed') continue;
        const state = reason === null ? 'applied' : 'skipped';
        const changed = await this.repo.settlePending(sent.rulingId, job.repoId, { state, appliedJobId: job.id, skipReason: reason });
        if (!changed) continue;
        const summary = summaries.get(changed.jobId) ?? { applied: [], skipped: [] };
        summary[state].push(`${sent.item} (${state === 'applied' ? applied?.disposition : reason})`);
        summaries.set(changed.jobId, summary);
      }
      for (const [runId, summary] of summaries) {
        const parts = [summary.applied.length ? `applied ${summary.applied.join(', ')}` : '', summary.skipped.length ? `skipped ${summary.skipped.join(', ')}` : ''].filter(Boolean);
        await this.ticketEffects.commentOnRulingResult(runId, `Finish ${job.id}: ${parts.join('; ')}`);
      }
    }
    const prNumber = prNumberOfReviewFeature(job.feature);
    if (job.fixReady?.markedReady && prNumber !== null) {
      for (const runId of await this.repo.runsForPr(job.repoId, prNumber)) {
        await this.ticketEffects.commentOnReady(runId, `PR #${prNumber} marked ready by FIX ${job.id}`);
      }
    }
  }

  replaceOlderRuns(runJob: { id: string }): Promise<void> { return this.repo.replaceOlderRuns(runJob.id); }

  async ruleTarget(projectId: string, jobId: string, dto: CreateRulingInput) {
    const target = await this.repo.findTarget(projectId, jobId);
    if (!target) throw new NotFoundAppException({}, 'fleet.jobs');
    if (target.command !== 'RUN' || target.outcome !== 'draft' || target.prNumber === null) throw new ConflictAppException({}, 'fleet.rulings.notDraft');
    if (await this.latestRunForPr(target.repoId, target.prNumber) !== jobId) throw new ConflictAppException({}, 'fleet.rulings.notLatest');
    const item = target.openItems.find((open) => open.id === dto.itemId);
    if (!item) throw new NotFoundAppException({}, 'fleet.rulings.unknownItem');
    // #394: a ci item is settled by rerunning CI; a FIX can only report `skipped: unknown-item`. Refuse it here,
    // before the forge read, so the caller never creates or approves a ruling that cannot apply.
    if (item.kind === 'ci') throw new ConflictAppException({}, 'fleet.rulings.notRulable');
    if (!parseRulingText(dto.text)) throw new ValidationAppException({ property: 'text' }, 'fleet.rulings.invalidText');
    if ((await this.repo.latestRuling(jobId, dto.itemId))?.state === 'applied') throw new ConflictAppException({}, 'fleet.rulings.settled');
    return target;
  }

  /**
   * #394: the pre-transaction gate REST, the approval replay and the assistant run before `create`.
   * Eligibility first, then the item-index forge read, so a refused target never costs a forge call.
   */
  async preflight(projectId: string, jobId: string, dto: CreateRulingInput): Promise<void> {
    await this.assertItemIndex(await this.ruleTarget(projectId, jobId, dto));
  }

  /**
   * #394: refuse a ruling nax could never settle because the PR carries no nax item index.
   * One page of comments, no pagination and no author check: a planted marker only restores today's
   * behaviour (a later `unknown-item` skip), and the check fails open on any forge failure, on a
   * missing installation id and on a full page, so an outage never blocks a ruling.
   */
  async assertItemIndex(target: RulingJobTarget): Promise<void> {
    const { repo, prNumber } = target;
    if (prNumber === null || repo.provider !== 'github' || repo.githubInstallationId === null) return;
    let bodies: string[];
    try {
      // pull_requests:read is what reading a PR's issue comments needs; the thread-read token grants exactly that.
      const { token } = await this.github.mintThreadReadToken(repo.githubInstallationId, repo.name);
      bodies = await this.github.listIssueComments(token, repo.owner, repo.name, prNumber);
    } catch {
      // Fail open. Deliberately unlogged: a provider error may carry the ephemeral credential.
      return;
    }
    if (bodies.length >= ITEM_INDEX_COMMENT_PAGE) return;
    if (bodies.some((body) => body.includes(NAX_ITEM_INDEX_MARKER))) return;
    throw new ConflictAppException({}, 'fleet.rulings.noItemIndex');
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
