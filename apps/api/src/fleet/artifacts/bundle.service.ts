import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { Readable } from 'stream';
import { FleetJobState } from '../../common/enums';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { LogFallbackService } from '../logs/log-fallback.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from '../sync/fence.service';
import { ARTIFACT_STORE, ArtifactHashMismatchError, ArtifactStore, ArtifactTooLargeError } from './artifact-store';
import { FleetBundleException, FleetFenceException } from './bundle.exceptions';

const UPLOAD_STATES: readonly string[] = [FleetJobState.RUNNING, FleetJobState.UPLOADING];
const SHA256_RE = /^[0-9a-f]{64}$/i;

export interface BundleUpload {
  runnerId: string;
  jobId: string;
  leaseEpochRaw: string | undefined;
  sha256Header: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}

@Injectable()
export class BundleService {
  private readonly logger = new Logger(BundleService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    @Inject(ARTIFACT_STORE) private readonly store: ArtifactStore,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'bundleMaxBytes'>,
    private readonly fallback: LogFallbackService,
  ) {}

  /** Spec §3.3: fenced, RUNNING (partial bundle on cancel) or UPLOADING only, streamed, hash-checked. */
  async upload(u: BundleUpload): Promise<{ jobId: string; leaseEpoch: number; sizeBytes: string; sha256: string }> {
    if (!/^application\/gzip\b/i.test(u.contentType ?? '')) throw new FleetBundleException(415);
    const leaseEpoch = Number(u.leaseEpochRaw);
    if (!Number.isInteger(leaseEpoch) || leaseEpoch < 0) throw new ValidationAppException({ reason: 'leaseEpoch' }, 'fleet.bundleInput');
    if (!SHA256_RE.test(u.sha256Header ?? '')) throw new ValidationAppException({ reason: 'X-Content-SHA256' }, 'fleet.bundleInput');
    const maxBytes = this.fleetConfig.bundleMaxBytes;
    if (u.contentLength !== undefined && Number(u.contentLength) > maxBytes) throw new FleetBundleException(413, { maxBytes });

    await this.assertHolder(u.runnerId, u.jobId, leaseEpoch);
    // Per-attempt key (plan D3): the previous bundle stays intact until the row points at this one.
    const key = `jobs/${u.jobId}/${leaseEpoch}/${randomUUID()}.tar.gz`;
    let stored: { sizeBytes: number; sha256: string };
    try {
      stored = await this.store.put(key, u.body, { maxBytes, expectedSha256: u.sha256Header as string });
    } catch (error) {
      if (error instanceof ArtifactTooLargeError) throw new FleetBundleException(413, { maxBytes });
      if (error instanceof ArtifactHashMismatchError) throw new FleetBundleException(422, { reason: 'sha256 mismatch' });
      throw error;
    }
    // The lease may have moved while the body streamed: re-check before recording.
    const recorded = await this.txManager.run(async () => {
      const job = await this.repo.lockById(u.jobId);
      if (!job) return { ok: false as const, error: new NotFoundAppException({}, 'fleet.jobs') };
      if (!this.fence.holds(job, u.runnerId, leaseEpoch)) {
        await this.fence.abandon(u.runnerId, job, leaseEpoch);
        return { ok: false as const, error: new FleetFenceException() };
      }
      if (!UPLOAD_STATES.includes(job.state)) {
        return { ok: false as const, error: new ConflictAppException({ state: job.state }, 'fleet.jobState') };
      }
      const previous = await this.repo.findArtifact(job.id, 'bundle', leaseEpoch);
      await this.repo.upsertArtifact({ jobId: job.id, leaseEpoch, kind: 'bundle', storageKey: key, sizeBytes: BigInt(stored.sizeBytes), sha256: stored.sha256 });
      await this.activity.record({
        actorType: 'RUNNER', actorId: u.runnerId, action: 'job.bundle_uploaded', entityType: 'job', entityId: job.id, jobId: job.id,
        projectId: job.projectId, responsibleUserId: job.requestedById, payload: { leaseEpoch, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
      });
      return { ok: true as const, replacedKey: previous?.storageKey ?? null };
    });
    if (!recorded.ok) {
      await this.store.delete(key); // only this attempt's file; the recorded bundle is untouched
      // Throw after commit so the stale lease's ABANDON is not rolled back.
      throw recorded.error;
    }
    // S2a §2.5: fill unfinished log streams from this bundle, off the request path.
    this.fallback.schedule({ jobId: u.jobId, leaseEpoch, storageKey: key });
    if (recorded.replacedKey) {
      try {
        await this.store.delete(recorded.replacedKey);
      } catch (error) {
        // Plan D3 / review 2b ENH-1: the DB row now points at the new file. If we can't
        // delete the replaced file (fs error, EACCES, EBUSY), it has no DB pointer and
        // accumulates on disk. Log an activity so an operator can intervene; the bundle
        // upload itself still succeeded.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to delete replaced bundle ${recorded.replacedKey}: ${message}`);
        await this.activity.record({
          actorType: 'SYSTEM', actorId: 'system', action: 'bundle.orphan_file', entityType: 'job', entityId: u.jobId, jobId: u.jobId,
          projectId: (await this.repo.findById(u.jobId))?.projectId ?? null,
          responsibleUserId: null, payload: { replacedPath: recorded.replacedKey, error: message },
        });
      }
    }
    return { jobId: u.jobId, leaseEpoch, sizeBytes: String(stored.sizeBytes), sha256: stored.sha256 };
  }

  async download(projectId: string, jobId: string): Promise<{ stream: Readable; leaseEpoch: number; sizeBytes: bigint }> {
    const job = await this.repo.findById(jobId);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    const artifact = await this.repo.findLatestArtifact(jobId, 'bundle');
    if (!artifact) throw new NotFoundAppException({}, 'fleet.bundle');
    return { stream: await this.store.get(artifact.storageKey), leaseEpoch: artifact.leaseEpoch, sizeBytes: artifact.sizeBytes };
  }

  private async assertHolder(runnerId: string, jobId: string, leaseEpoch: number): Promise<void> {
    const outcome = await this.txManager.run(async () => {
      const job = await this.repo.lockById(jobId);
      if (!job) return 'missing' as const;
      if (!this.fence.holds(job, runnerId, leaseEpoch)) {
        await this.fence.abandon(runnerId, job, leaseEpoch);
        return 'fenced' as const;
      }
      return UPLOAD_STATES.includes(job.state) ? ('ok' as const) : job.state;
    });
    if (outcome === 'missing') throw new NotFoundAppException({}, 'fleet.jobs');
    if (outcome === 'fenced') throw new FleetFenceException();
    if (outcome !== 'ok') throw new ConflictAppException({ state: outcome }, 'fleet.jobState');
  }
}
