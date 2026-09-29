import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { parseCapabilities } from '../common/capabilities';
import { isSupportedProtocolVersion } from '../common/protocol';
import type { FleetCommandOut, JobAck, SyncResponse } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { PlacementService } from '../jobs/placement.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ProtocolVersionException } from '../runners/protocol-version.exception';
import { CommandAckProcessor } from './command-ack.processor';
import { JobReportProcessor } from './job-report.processor';
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
    private readonly notifier: RunnerNotifier,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'syncWaitMs'>,
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

    const live: LiveFleetJobEvent[] = [...(await this.acks.process(runnerId, req.bootId, req.commandAcks, now))];
    const jobAcks: JobAck[] = [];
    const unknownJobIds: string[] = [];
    const terminalJobIds: string[] = [];
    for (const report of req.jobs) {
      // One failing job must not block the rest of the sync (review M2): no ack for it, the runner resends it.
      try {
        const outcome = await this.reports.process(runnerId, report, now);
        if (outcome.ack) jobAcks.push(outcome.ack);
        if (outcome.unknown) unknownJobIds.push(report.jobId);
        if (outcome.terminalJobId) terminalJobIds.push(outcome.terminalJobId);
        live.push(...outcome.live);
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
    if (req.freeSlots > 0) await this.placement.fillRunner(runnerId, req.freeSlots, now);
    await this.afterTerminal(terminalJobIds);

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

  /** Task 15 mints tokens here. */
  protected async grantTokens(_runnerId: string, _requests: ReadonlyArray<{ jobId: string; leaseEpoch: number }>, _now: Date) {
    return { gitTokens: [], gitTokenErrors: [], unknownJobIds: [] as string[] };
  }

  /** Task 15 evicts cached tokens, Task 19 posts the attribution comment. */
  protected async afterTerminal(_jobIds: readonly string[]): Promise<void> {
    return undefined;
  }

  private async deliver(runnerId: string, now: Date): Promise<FleetCommandOut[]> {
    const pending = await this.repo.findPendingCommands(runnerId);
    await this.repo.markDelivered(pending.filter((c) => c.deliveredAt === null).map((c) => c.id), now);
    return pending.map((c) => ({ commandId: c.id, type: c.type, jobId: c.jobId, leaseEpoch: c.leaseEpoch, payload: c.payload as FleetCommandOut['payload'] }));
  }
}
