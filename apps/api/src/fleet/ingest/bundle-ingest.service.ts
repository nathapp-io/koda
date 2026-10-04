import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { BudgetEvaluator } from '../budgets/budget-evaluator';
import { jobSpendKeys } from '../budgets/budget-rules';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { readBundleFiles } from './bundle-reader';
import {
  BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_BACKOFF_MS, INGEST_DRAIN_LIMIT, INGEST_LIMITS, INGEST_MAX_ATTEMPTS, IngestClaim,
} from './domain/bundle-ingest.domain';
import { computeCorrection } from './ingest-corrections';
import { parseBundle } from './parse-bundle';

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
      await this.repo.replaceRows(
        { jobId: job.id, leaseEpoch: claim.leaseEpoch, projectId: job.projectId, repoId: job.repoId, runnerId: job.runnerId, naxRunId: parsed.naxRunId },
        parsed.rows,
      );
      const correction = computeCorrection({ job, leaseEpoch: claim.leaseEpoch, ledgerCostUsd: parsed.ledgerCostUsd, runStatus: parsed.runStatus, finish: parsed.finish });
      const changed = Object.keys(correction.patch).length > 0;
      const updated = changed ? await this.jobs.update(job.id, correction.patch) : job;
      if (correction.escalated) {
        await this.jobs.appendEvent(job.id, { leaseEpoch: claim.leaseEpoch, runnerSeq: null, type: 'state', payload: { from: job.state, to: updated.state, by: 'server', reason: updated.stateReason } });
        await this.activity.record({
          actorType: 'SYSTEM', actorId: 'system', action: 'job.verdict_corrected', entityType: 'job', entityId: job.id, jobId: job.id,
          projectId: job.projectId, responsibleUserId: job.requestedById, payload: { from: job.state, to: updated.state, source: 'finish-audit' },
        });
      }
      await this.repo.markOutcome(claim.id, {
        kind: parsed.partial ? 'partial' : 'done', files: parsed.files, liveCostUsd: correction.liveCostUsd, ledgerCostUsd: parsed.ledgerCostUsd, ingestedAt: now,
      });
      return { event: this.live.event(updated), spendKeys: correction.costRaised ? jobSpendKeys(updated) : [] };
    });
    if (!result) return;
    this.live.publish([result.event]);
    if (result.spendKeys.length > 0) this.budgets.signal(result.spendKeys);
  }

  private async recordFailure(claim: IngestClaim, error: unknown, now: Date): Promise<void> {
    const attempts = claim.attempts + 1;
    const message = trimError(error);
    this.logger.warn(`bundle ingest ${claim.id} (job ${claim.jobId}) failed attempt ${attempts}: ${message}`);
    if (attempts >= INGEST_MAX_ATTEMPTS) await this.repo.markFailed(claim.id, attempts, message);
    else await this.repo.markRetry(claim.id, attempts, new Date(now.getTime() + INGEST_BACKOFF_MS[attempts - 1]), message);
  }
}
