import { Inject, Injectable, Logger } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { extractBundleMembers, listBundleMembers, pickLogMembers } from './bundle-log-extractor';
import { FLEET_JOB_LOG_REPOSITORY, IFleetJobLogRepository, LOG_STREAMS, LogStreamName } from './domain/fleet-job-log.domain';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LOG_STORE, LogStore, logKey } from './log-store';

export interface FallbackInput {
  jobId: string;
  leaseEpoch: number;
  storageKey: string;
}

/** Spec §2.5, plan D316-D318: fill streams the runner did not finish from the attempt's bundle, off the request path. */
@Injectable()
export class LogFallbackService {
  private readonly logger = new Logger(LogFallbackService.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(ARTIFACT_STORE) private readonly artifacts: Pick<ArtifactStore, 'get'>,
    @Inject(LOG_STORE) private readonly store: LogStore,
    @Inject(FLEET_JOB_LOG_REPOSITORY) private readonly logs: Pick<IFleetJobLogRepository, 'listForAttempt' | 'completeFromBundle'>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    private readonly live: FleetLogLivePublisher,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'logMaxBytes'>,
  ) {}

  schedule(input: FallbackInput): void {
    this.queue = this.queue.then(() => this.fill(input)).catch((error: unknown) => {
      this.logger.warn(`log fallback failed for job ${input.jobId} epoch ${input.leaseEpoch}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  idle(): Promise<void> {
    return this.queue;
  }

  async fill(input: FallbackInput): Promise<void> {
    const job = await this.jobs.findById(input.jobId);
    if (!job) return;
    const rows = await this.logs.listForAttempt(input.jobId, input.leaseEpoch);
    const done = new Set(rows.filter((r) => r.complete || r.truncated).map((r) => r.stream));
    const open = LOG_STREAMS.filter((s) => !done.has(s));
    if (open.length === 0) return;
    const members = await listBundleMembers(await this.artifacts.get(input.storageKey));
    const picked = pickLogMembers(members, {
      command: job.command, feature: job.feature, naxLogRunId: job.leaseEpoch === input.leaseEpoch ? job.naxLogRunId : null,
    });
    const wanted = new Map<string, LogStreamName>(open.flatMap((s) => (picked[s] ? [[picked[s].name, s] as [string, LogStreamName]] : [])));
    if (wanted.size === 0) return;
    await extractBundleMembers(await this.artifacts.get(input.storageKey), wanted, async (stream, entry, member) => {
      const key = logKey(input.jobId, input.leaseEpoch, stream);
      const filled = await this.store.withLock(key, async () => {
        const current = (await this.logs.listForAttempt(input.jobId, input.leaseEpoch)).find((r) => r.stream === stream);
        if (current && (current.complete || current.truncated)) return null;
        if (member.size < (await this.store.size(key))) return null;
        const written = await this.store.replace(key, entry, this.cfg.logMaxBytes);
        const truncated = member.size > this.cfg.logMaxBytes;
        return (await this.logs.completeFromBundle(input.jobId, input.leaseEpoch, stream, { sizeBytes: written, truncated })) ? { written, truncated } : null;
      });
      if (filled) {
        this.live.touch({ projectId: job.projectId, jobId: input.jobId, leaseEpoch: input.leaseEpoch, stream, size: filled.written, complete: !filled.truncated }, true);
      }
    });
  }
}
