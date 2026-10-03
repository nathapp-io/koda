import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import type { LiveFleetApprovalEvent, LiveFleetJobEvent } from '../../live/live-event';
import { parseCapabilities } from '../common/capabilities';
import { isSupportedProtocolVersion } from '../common/protocol';
import type { FleetCommandOut, GitToken, GitTokenError, JobAck, SyncResponse } from '../common/protocol';
import { ApprovalLivePublisher } from '../approvals/approval-live.publisher';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { PlacementService } from '../jobs/placement.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { RUNNER_HELD_STATES, isTerminal } from '../jobs/job-state';
import { ProtocolVersionException } from '../runners/protocol-version.exception';
import { FenceService } from './fence.service';
import { CommandAckProcessor } from './command-ack.processor';
import { JobReportProcessor } from './job-report.processor';
import { PrAttributionService } from './pr-attribution.service';
import { parseSyncRequest } from './sync-request.parser';

/**
 * POST /fleet/runner/sync (spec §3.2). Step 1 is several short transactions (plan D5):
 * acks, one per reported job, boot reconcile, placement fill. Step 2, only when there is
 * nothing to return: wait for a command, holding no transaction or connection.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly reports: JobReportProcessor,
    private readonly acks: CommandAckProcessor,
    private readonly placement: PlacementService,
    private readonly live: FleetJobLivePublisher,
    private readonly approvalLive: ApprovalLivePublisher,
    private readonly notifier: RunnerNotifier,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'syncWaitMs'>,
    private readonly broker: GitTokenBroker,
    private readonly fence: FenceService,
    private readonly attribution: PrAttributionService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async sync(runnerId: string, raw: unknown): Promise<SyncResponse> {
    const version = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).protocolVersion : undefined;
    if (!isSupportedProtocolVersion(version)) throw new ProtocolVersionException(version);
    const req = parseSyncRequest(raw);
    const capabilities = req.capabilities === undefined ? undefined : parseCapabilities(req.capabilities);
    const now = new Date();
    const seen = await this.repo.recordRunnerSync(runnerId, {
      now, bootId: req.bootId, daemonVersion: req.daemonVersion, protocolVersion: req.protocolVersion, capabilities,
    });
    if (!seen) throw new AuthException({}, 'fleet.runnerAuth');

    const { live: ackLive, approvalLive: ackApprovalLive } = await this.acks.process(runnerId, req.bootId, req.commandAcks, now);
    const live: LiveFleetJobEvent[] = [...ackLive];
    const approvalLive: LiveFleetApprovalEvent[] = [...ackApprovalLive];
    const jobAcks: JobAck[] = [];
    const unknownJobIds: string[] = [];
    for (const report of req.jobs) {
      // One failing job must not block the rest of the sync (review M2): no ack for it, the runner resends it.
      try {
        const outcome = await this.reports.process(runnerId, report, now);
        if (outcome.ack) jobAcks.push(outcome.ack);
        if (outcome.unknown) unknownJobIds.push(report.jobId);
        live.push(...outcome.live);
        approvalLive.push(...outcome.approvalLive);
      } catch (error) {
        this.logger.error(`Sync: job ${report.jobId} from runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    // Every sync, not only when the boot id changed (review M3): a crash between recording the new
    // boot id and queueing READOPT must not strand held jobs. Idempotent through runnerBootId and
    // the pending-READOPT check.
    try {
      await this.acks.reconcileBoot(runnerId, req.bootId, now, seen.previousBootId !== req.bootId);
    } catch (error) {
      this.logger.error(`Sync: boot reconcile for runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    this.live.publish(live);
    this.approvalLive.publish(approvalLive);
    if (req.freeSlots > 0) await this.placement.fillRunner(runnerId, req.freeSlots, now);
    await this.afterTerminal(live.filter((e) => isTerminal(e.state)).map((e) => e.jobId));

    const tokens = await this.grantTokens(runnerId, req.tokenRequests, now);
    let commands = await this.deliver(runnerId, now);
    const idle = jobAcks.length === 0 && unknownJobIds.length === 0 && commands.length === 0 &&
      tokens.gitTokens.length === 0 && tokens.gitTokenErrors.length === 0 && tokens.unknownJobIds.length === 0;
    if (idle) {
      await this.notifier.wait(runnerId, this.fleetConfig.syncWaitMs, async () => (await this.repo.findPendingCommands(runnerId)).length > 0);
      commands = await this.deliver(runnerId, new Date());
    }
    return {
      jobAcks, commands, gitTokens: tokens.gitTokens, gitTokenErrors: tokens.gitTokenErrors,
      unknownJobIds: [...new Set([...unknownJobIds, ...tokens.unknownJobIds])],
    };
  }

  /** Spec §6.3: fence each request (ABANDON on a stale epoch), then mint outside any transaction. */
  protected async grantTokens(runnerId: string, requests: ReadonlyArray<{ jobId: string; leaseEpoch: number }>, now: Date) {
    const gitTokens: GitToken[] = [];
    const gitTokenErrors: GitTokenError[] = [];
    const unknownJobIds: string[] = [];
    const toMint = await this.txManager.run(async () => {
      const granted: Array<{ jobId: string; leaseEpoch: number; repo: FleetRepoRef }> = [];
      for (const req of requests) {
        // Row lock: two overlapping syncs from one runner must not both queue an ABANDON.
        const job = await this.repo.lockById(req.jobId);
        if (!job) {
          unknownJobIds.push(req.jobId);
        } else if (!this.fence.holds(job, runnerId, req.leaseEpoch)) {
          await this.fence.abandon(runnerId, job, req.leaseEpoch);
        } else if (!(RUNNER_HELD_STATES as readonly string[]).includes(job.state)) {
          gitTokenErrors.push({ jobId: job.id, reason: 'job_not_active' });
        } else {
          const repo = await this.repo.findRepo(job.repoId);
          if (repo) granted.push({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo });
        }
      }
      return granted;
    });
    for (const req of toMint) {
      const result = await this.broker.mint(req, now);
      // strictNullChecks is off repo-wide, so `result.ok` does not narrow the MintResult union; `in` does.
      if ('error' in result) gitTokenErrors.push(result.error);
      else gitTokens.push(result.token);
    }
    return { gitTokens, gitTokenErrors, unknownJobIds };
  }

  /** Evicts cached tokens; posts the attribution comment (spec §7.1). */
  protected async afterTerminal(jobIds: readonly string[]): Promise<void> {
    for (const id of new Set(jobIds)) {
      this.broker.evict(id);
      void this.attribution.attribute(id); // fire-and-forget; never throws
    }
  }

  private async deliver(runnerId: string, now: Date): Promise<FleetCommandOut[]> {
    const pending = await this.repo.findPendingCommands(runnerId);
    await this.repo.markDelivered(pending.filter((c) => c.deliveredAt === null).map((c) => c.id), now);
    return pending.map((c) => ({ commandId: c.id, type: c.type, jobId: c.jobId, leaseEpoch: c.leaseEpoch, payload: c.payload as FleetCommandOut['payload'] }));
  }
}
