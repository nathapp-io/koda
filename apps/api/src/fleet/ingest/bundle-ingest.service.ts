import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { responsibleUserOf } from '../common/responsible-user';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { BudgetEvaluator } from '../budgets/budget-evaluator';
import { jobSpendKeys } from '../budgets/budget-rules';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';
import { readBundleFiles } from './bundle-reader';
import {
  BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_BACKOFF_MS, INGEST_DRAIN_LIMIT, INGEST_LIMITS, INGEST_MAX_ATTEMPTS, IngestClaim,
} from './domain/bundle-ingest.domain';
import { computeCorrection } from './ingest-corrections';
import { parseBundle } from './parse-bundle';
import { FleetJobOutcomeRecorder } from '../jobs/job-outcome.recorder';
import { KNOWLEDGE_RUN_INGESTED, type KnowledgeRunIngestedEvent } from '../common/knowledge-events';

const SECRETISH = /(token|secret|password|key)=\S+/gi;
const trimError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(SECRETISH, '$1=***').slice(0, INGEST_LIMITS.errorText);

/** Fleet S2b (d) §2-§3: claim one bundle, parse it, write rows and corrections in one transaction. */
@Injectable()
export class BundleIngestService {
  private readonly logger = new Logger(BundleIngestService.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly repo: IBundleIngestRepository,
    @Inject(ARTIFACT_STORE) private readonly store: Pick<ArtifactStore, 'get'>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById' | 'update' | 'appendEvent'>,
    private readonly live: FleetJobLivePublisher,
    private readonly activity: FleetActivityService,
    private readonly budgets: BudgetEvaluator,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly ticketEffects: FleetJobTicketEffects,
    private readonly outcomes: FleetJobOutcomeRecorder,
    /** S5b 3c-2-D8 (US-004): carries `KNOWLEDGE_RUN_INGESTED`; the ingest is the outcome pass's only trigger. */
    private readonly events: EventEmitter2,
  ) {}

  /** D369: off the request path; never throws. */
  kick(): void {
    this.queue = this.queue.then(() => this.drain().then(() => undefined)).catch((error: unknown) => {
      this.logger.warn(`bundle ingest drain failed: ${trimError(error)}`);
    });
  }

  idle(): Promise<void> {
    return this.queue;
  }

  async drain(now = new Date()): Promise<number> {
    let done = 0;
    while (done < INGEST_DRAIN_LIMIT && (await this.ingestOne(now))) done += 1;
    return done;
  }

  /** One claimed row end to end. Returns false when nothing was claimable. Failures are recorded, never thrown. */
  async ingestOne(now: Date): Promise<boolean> {
    const claim = await this.repo.claimNext(now);
    if (!claim) return false;
    try {
      const artifact = await this.repo.findArtifact(claim.artifactId);
      if (!artifact || artifact.expiredAt) {
        await this.repo.markFailed(claim.id, claim.attempts + 1, 'bundle expired');
        return true;
      }
      const files = await readBundleFiles(await this.store.get(artifact.storageKey));
      await this.write(claim, files, now);
    } catch (error) {
      await this.recordFailure(claim, error, now);
    }
    return true;
  }

  private async write(claim: IngestClaim, files: Awaited<ReturnType<typeof readBundleFiles>>, now: Date): Promise<void> {
    const result = await this.txManager.run(async () => {
      const job = await this.jobs.lockById(claim.jobId);
      if (!job) return null;
      const parsed = parseBundle(files, job.leaseEpoch === claim.leaseEpoch ? job.naxRunId : null);
      // S5b 3c-2-D1: outcomes are stored for RUN jobs only; every other command writes an empty list.
      const isRun = job.command === 'RUN';
      await this.repo.replaceRows(
        { jobId: job.id, leaseEpoch: claim.leaseEpoch, projectId: job.projectId, repoId: job.repoId, runnerId: job.runnerId, naxRunId: parsed.naxRunId },
        { ...parsed.rows, outcomes: isRun ? parsed.rows.outcomes ?? [] : [] },
      );
      const correction = computeCorrection({ job, leaseEpoch: claim.leaseEpoch, ledgerCostUsd: parsed.ledgerCostUsd, runStatus: parsed.runStatus, finish: parsed.finish, workflow: parsed.workflow ?? null, workflowOutcome: parsed.workflowOutcome ?? null, workflowUrl: parsed.workflowUrl ?? null });
      const changed = Object.keys(correction.patch).length > 0;
      const updated = changed ? await this.jobs.update(job.id, correction.patch) : job;
      const prFilled = 'resultPrUrl' in correction.patch;
      if (correction.escalated || prFilled) await this.outcomes.onIngestCorrection(updated, { escalated: correction.escalated, prFilled });
      if (correction.escalated) {
        await this.jobs.appendEvent(job.id, { leaseEpoch: claim.leaseEpoch, runnerSeq: null, type: 'state', payload: { from: job.state, to: updated.state, by: 'server', reason: updated.stateReason } });
        await this.activity.record({
          actorType: 'SYSTEM', actorId: 'system', action: 'job.verdict_corrected', entityType: 'job', entityId: job.id, jobId: job.id,
          projectId: job.projectId, responsibleUserId: responsibleUserOf(job), payload: { from: job.state, to: updated.state, source: correction.escalatedFrom ?? 'finish-audit' },
        });
      }
      await this.repo.markOutcome(claim.id, {
        kind: parsed.partial ? 'partial' : 'done', files: parsed.files, liveCostUsd: correction.liveCostUsd, ledgerCostUsd: parsed.ledgerCostUsd, ingestedAt: now,
      });
      // `isRun` travels with the commit result for the post-commit outcome-index hook (S5b 3c-2-D8, US-004).
      return { event: this.live.event(updated), spendKeys: correction.costRaised ? jobSpendKeys(updated) : [], prFilled, isRun };
    });
    if (!result) return;
    this.live.publish([result.event]);
    if (result.spendKeys.length > 0) this.budgets.signal(result.spendKeys);
    if (result.prFilled) void this.ticketEffects.upsertPrLinks(claim.jobId); // C9 §3.3: late PR URL; never throws
    // S5b 3c-2-D8: the outcome pass runs after the commit, never inside it, once per ingest and only for a
    // RUN job: a PLAN or CONFIG_EDIT job stores no outcome rows, and a RUN ingest without outcome rows
    // retires the epoch before it.
    if (result.isRun && !this.events.emit(KNOWLEDGE_RUN_INGESTED, { jobId: claim.jobId } satisfies KnowledgeRunIngestedEvent)) {
      this.logger.warn(`no listener for ${KNOWLEDGE_RUN_INGESTED} (job ${claim.jobId}); its outcome pass was not queued`);
    }
  }

  private async recordFailure(claim: IngestClaim, error: unknown, now: Date): Promise<void> {
    const attempts = claim.attempts + 1;
    const message = trimError(error);
    this.logger.warn(`bundle ingest ${claim.id} (job ${claim.jobId}) failed attempt ${attempts}: ${message}`);
    if (attempts >= INGEST_MAX_ATTEMPTS) await this.repo.markFailed(claim.id, attempts, message);
    else await this.repo.markRetry(claim.id, attempts, new Date(now.getTime() + INGEST_BACKOFF_MS[attempts - 1]), message);
  }
}
