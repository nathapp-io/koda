import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { Readable } from 'stream';
import { FleetJobState } from '../../common/enums';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from '../sync/fence.service';
import { FLEET_JOB_LOG_REPOSITORY, IFleetJobLogRepository, isLogStream, LogStreamName } from './domain/fleet-job-log.domain';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LOG_STORE, LogStore, logKey } from './log-store';
import { FleetLogException } from './log-upload.exceptions';
import { readCappedBody } from './read-capped-body';
import { RunnerByteRate } from './runner-byte-rate';

export interface LogUpload {
  runnerId: string;
  jobId: string;
  streamRaw: string;
  leaseEpochRaw: string | undefined;
  offsetRaw: string | undefined;
  finalRaw: string | undefined;
  sha256Header: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}

export type LogUploadOutcome = 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';

export interface LogUploadResult {
  outcome: LogUploadOutcome;
  size: number;
  retryAfterMs?: number;
}

const UPLOAD_STATES: readonly string[] = [FleetJobState.ASSIGNED, FleetJobState.RUNNING, FleetJobState.UPLOADING];
const SHA256_RE = /^[0-9a-f]{64}$/i;
const NON_NEG_INT = /^(0|[1-9][0-9]{0,15})$/;

type Cfg = Pick<IFleetConfig, 'logMaxBytes' | 'logChunkMaxBytes' | 'logRunnerBytesPerSec'>;

interface Parsed {
  stream: LogStreamName;
  leaseEpoch: number;
  offset: number;
  final: boolean;
  sha256: string;
}

@Injectable()
export class LogUploadService {
  private readonly rate: RunnerByteRate;

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById' | 'lockById'>,
    private readonly fence: FenceService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(LOG_STORE) private readonly store: LogStore,
    @Inject(FLEET_JOB_LOG_REPOSITORY) private readonly logs: IFleetJobLogRepository,
    private readonly live: FleetLogLivePublisher,
    @Inject(FLEET_CFG) private readonly cfg: Cfg,
  ) {
    this.rate = new RunnerByteRate({ bytesPerSec: cfg.logRunnerBytesPerSec, burstBytes: cfg.logChunkMaxBytes });
  }

  /** Spec §2.2, plan D307: protocol outcomes are 200 results; errors are thrown. */
  async upload(u: LogUpload): Promise<LogUploadResult> {
    const p = this.parse(u);
    const declared = Number(u.contentLength);
    const charge = Number.isInteger(declared) && declared >= 0 ? declared : this.cfg.logChunkMaxBytes;
    const allowed = this.rate.take(u.runnerId, charge, Date.now());
    if (allowed.ok === 'no') {
      u.body.resume();
      return { outcome: 'rate_limited', size: -1, retryAfterMs: allowed.retryAfterMs };
    }
    const job = await this.assertHolder(u.runnerId, u.jobId, p.leaseEpoch);
    const read = await readCappedBody(u.body, this.cfg.logChunkMaxBytes);
    if (read.ok === 'too_large') throw new FleetLogException(413, { maxBytes: this.cfg.logChunkMaxBytes });
    const bytes = read.bytes;
    if (bytes.length === 0 && !p.final) throw new ValidationAppException({ reason: 'empty body' }, 'fleet.logInput');
    if (createHash('sha256').update(bytes).digest('hex') !== p.sha256.toLowerCase()) throw new FleetLogException(422);

    const key = logKey(job.id, p.leaseEpoch, p.stream);
    const result = await this.store.withLock(key, () => this.write(job.id, key, p, bytes));
    if (result.outcome === 'appended' || result.outcome === 'complete' || result.outcome === 'stream_cap') {
      const immediate = result.outcome !== 'appended';
      this.live.touch({ projectId: job.projectId, jobId: job.id, leaseEpoch: p.leaseEpoch, stream: p.stream, size: result.size, complete: result.outcome === 'complete' }, immediate);
    }
    return result;
  }

  private async write(jobId: string, key: string, p: Parsed, bytes: Buffer): Promise<LogUploadResult> {
    try {
      const row = await this.logs.findStream(jobId, p.leaseEpoch, p.stream);
      const size = await this.store.size(key);
      if (row?.complete) return { outcome: 'complete', size };
      if (row?.truncated) return { outcome: 'stream_cap', size };
      if (p.offset + bytes.length > this.cfg.logMaxBytes) {
        const fit = bytes.subarray(0, Math.max(0, this.cfg.logMaxBytes - p.offset));
        const r = fit.length > 0 ? await this.store.append(key, p.offset, fit) : { kind: p.offset <= size ? ('duplicate' as const) : ('conflict' as const), size };
        if (r.kind === 'conflict') return { outcome: 'offset', size: r.size };
        await this.logs.upsertStream(jobId, p.leaseEpoch, p.stream, { sizeBytes: r.size, truncated: true });
        return { outcome: 'stream_cap', size: r.size };
      }
      const r = bytes.length > 0 ? await this.store.append(key, p.offset, bytes) : { kind: p.offset === size ? ('duplicate' as const) : ('conflict' as const), size };
      if (r.kind === 'conflict') return { outcome: 'offset', size: r.size };
      if (p.final) {
        if (r.size !== p.offset + bytes.length) return { outcome: 'offset', size: r.size };
        await this.logs.upsertStream(jobId, p.leaseEpoch, p.stream, { sizeBytes: r.size, complete: true });
        return { outcome: 'complete', size: r.size };
      }
      await this.logs.upsertStream(jobId, p.leaseEpoch, p.stream, { sizeBytes: r.size });
      return { outcome: r.kind, size: r.size };
    } catch (error) {
      if (error instanceof FleetLogException) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EIO' || code === 'EROFS') throw new FleetLogException(507);
      throw error;
    }
  }

  private parse(u: LogUpload): Parsed {
    const bad = (reason: string) => new ValidationAppException({ reason }, 'fleet.logInput');
    if (!isLogStream(u.streamRaw)) throw bad('stream');
    if (!NON_NEG_INT.test(u.leaseEpochRaw ?? '')) throw bad('leaseEpoch');
    if (!NON_NEG_INT.test(u.offsetRaw ?? '')) throw bad('offset');
    if (u.finalRaw !== undefined && u.finalRaw !== '1') throw bad('final');
    if (!SHA256_RE.test(u.sha256Header ?? '')) throw bad('X-Content-SHA256');
    return { stream: u.streamRaw, leaseEpoch: Number(u.leaseEpochRaw), offset: Number(u.offsetRaw), final: u.finalRaw === '1', sha256: u.sha256Header as string };
  }

  /**
   * Plan D310: unlocked read on the hot path; lock + ABANDON only when the fence fails.
   *
   * @design The `state` check is on the unlocked row. A terminal transition racing
   * the append is invisible to this check, and the upload is stored for a job that
   * just ended. The consequence is bounded: the reader serves the bytes like any
   * other bytes, and the `leaseEpoch` bump that comes with a requeue is the real
   * fence. `BundleService.upload` re-checks `state` under the lock; we accept the
   * looser invariant here for the per-chunk hot path.
   */
  private async assertHolder(runnerId: string, jobId: string, leaseEpoch: number) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    if (!this.fence.holds(job, runnerId, leaseEpoch)) {
      const fenced = await this.txManager.run(async () => {
        const locked = await this.jobs.lockById(jobId);
        if (locked && !this.fence.holds(locked, runnerId, leaseEpoch)) {
          await this.fence.abandon(runnerId, locked, leaseEpoch);
          return true;
        }
        return locked === null;
      });
      if (fenced) throw new FleetFenceException();
    }
    if (!UPLOAD_STATES.includes(job.state)) throw new ConflictAppException({ state: job.state }, 'fleet.jobState');
    return job;
  }
}
