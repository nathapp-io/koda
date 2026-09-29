import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetCommandAckResult, FleetCommandType, FleetJobState } from '../../common/enums';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { CommandAck } from '../common/protocol';
import { canTransition } from '../jobs/job-state';
import { JobTransitionsService } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from './fence.service';

/** Command acks (spec §3.2, plan D8) and the boot-id reconcile (spec §5.3, C3). */
@Injectable()
export class CommandAckProcessor {
  private readonly logger = new Logger(CommandAckProcessor.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** One transaction per ack, and a failing ack is logged and skipped, so one bad ack never blocks the rest. */
  async process(runnerId: string, bootId: string, acks: readonly CommandAck[], now: Date): Promise<LiveFleetJobEvent[]> {
    const live: LiveFleetJobEvent[] = [];
    for (const ack of acks) {
      try {
        const event = await this.txManager.run(() => this.processOne(runnerId, bootId, ack, now));
        if (event) live.push(event);
      } catch (error) {
        // Left unacked: the runner re-acks it next sync (review M2).
        this.logger.error(`Ack ${ack.commandId} from runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    return live;
  }

  private async processOne(runnerId: string, bootId: string, ack: CommandAck, now: Date): Promise<LiveFleetJobEvent | null> {
    const command = await this.repo.findCommand(ack.commandId);
    if (!command || command.runnerId !== runnerId || command.leaseEpoch !== ack.leaseEpoch) {
      this.logger.warn(`Ignoring ack for unknown or foreign command ${ack.commandId} from runner ${runnerId}`);
      return null;
    }
    if (command.ackedAt) return null; // already applied, withdrawn or stale: idempotent
    if (command.type === FleetCommandType.ABANDON) {
      await this.repo.ackCommand(command.id, ack.result, now);
      return null;
    }
    const job = await this.repo.lockById(command.jobId);
    if (!job || !this.fence.holds(job, runnerId, command.leaseEpoch)) {
      await this.repo.ackCommand(command.id, FleetCommandAckResult.STALE, now);
      if (job) await this.fence.abandon(runnerId, job, command.leaseEpoch);
      return null;
    }
    await this.repo.ackCommand(command.id, ack.result, now);
    const actor = { type: 'RUNNER' as const, id: runnerId };
    const detail = (ack.detail ?? '').slice(0, 200);

    if (command.type === FleetCommandType.READOPT) {
      if (ack.result === 'ok') {
        await this.repo.update(job.id, { runnerBootId: bootId });
        return null;
      }
      return (await this.transitions.apply({ job, to: FleetJobState.CRASHED, by: 'server', now, actor, reason: `readopt rejected: ${detail}` })).live;
    }
    if (ack.result === 'ok') return null;
    if (command.type === FleetCommandType.ASSIGN && canTransition(job.state, FleetJobState.FAILED, 'runner')) {
      return (await this.transitions.apply({ job, to: FleetJobState.FAILED, by: 'runner', now, actor, reason: `assign rejected: ${detail}` })).live;
    }
    if (command.type === FleetCommandType.CANCEL && canTransition(job.state, FleetJobState.CANCELLED, 'runner')) {
      return (await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'runner', now, actor, reason: 'cancel: runner does not hold job' })).live;
    }
    return null;
  }

  /**
   * Runs on every sync. Held jobs whose runnerBootId differs from the reported boot (the daemon
   * restarted) get one READOPT each; an ASSIGN never acked is simply re-sent (it is still pending).
   * `rebooted` only decides whether a `runner.rebooted` activity row is written.
   */
  async reconcileBoot(runnerId: string, bootId: string, now: Date, rebooted: boolean): Promise<number> {
    return this.txManager.run(async () => {
      let queued = 0;
      for (const job of await this.repo.findRunnerHeld(runnerId)) {
        if (job.runnerBootId === bootId) continue;
        const pendingAssign = job.state === FleetJobState.ASSIGNED
          ? await this.repo.findPendingCommand({ jobId: job.id, type: FleetCommandType.ASSIGN, leaseEpoch: job.leaseEpoch })
          : null;
        if (pendingAssign) {
          await this.repo.update(job.id, { runnerBootId: bootId });
          continue;
        }
        if (await this.repo.findPendingCommand({ jobId: job.id, type: FleetCommandType.READOPT, leaseEpoch: job.leaseEpoch })) continue;
        await this.repo.createCommand({ runnerId, jobId: job.id, type: FleetCommandType.READOPT, leaseEpoch: job.leaseEpoch, payload: { naxRunId: job.naxRunId } });
        queued += 1;
      }
      if (rebooted || queued > 0) {
        await this.activity.record({
          actorType: 'RUNNER', actorId: runnerId, action: 'runner.rebooted', entityType: 'runner', entityId: runnerId,
          payload: { readopts: queued, at: now.toISOString() },
        });
      }
      return queued;
    });
  }
}
