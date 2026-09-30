import type { CommandAck, FleetCommandOut } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Journal } from '../journal/journal';
import type { Logger } from '../logger';
import { jobDirFor } from '../paths/safe-segment';
import type { Now } from '../time';
import { parseAssign } from './assign-parser';
import type { Supervisor } from './supervisor';

export interface CommandHandlerDeps {
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly workspaceRoot: string;
  readonly log: Logger;
  readonly now: Now;
}

type Outcome = { result: 'ok' | 'rejected'; detail?: string };

/** Turns server commands into acks (design §1.3). Every applied command is recorded so a re-sent one is acked, not re-run. */
export class CommandHandler {
  constructor(private readonly deps: CommandHandlerDeps) {}

  async handle(commands: readonly FleetCommandOut[]): Promise<CommandAck[]> {
    const acks: CommandAck[] = [];
    for (const command of commands) acks.push(await this.handleOne(command));
    return acks;
  }

  private ack(command: FleetCommandOut, outcome: Outcome): CommandAck {
    return { commandId: command.commandId, leaseEpoch: command.leaseEpoch, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }

  private record(command: FleetCommandOut, outcome: Outcome): void {
    this.deps.journal.recordCommand({
      commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch, type: String(command.type),
      result: outcome.result, detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString(),
    });
  }

  private async handleOne(command: FleetCommandOut): Promise<CommandAck> {
    const prior = this.deps.journal.getCommand(command.commandId);
    if (prior) {
      if (prior.type === 'ASSIGN' && prior.result === 'ok') this.resumeStranded(prior.jobId, prior.leaseEpoch);
      return this.ack(command, { result: prior.result, ...(prior.detail ? { detail: prior.detail } : {}) });
    }
    let outcome: Outcome;
    try {
      outcome = await this.apply(command);
    } catch (error) {
      this.deps.log.error('command failed', { commandId: command.commandId, type: command.type, error: errorMessage(error) });
      return this.ack(command, { result: 'rejected', detail: 'runner error' });
    }
    return this.ack(command, outcome);
  }

  private async apply(command: FleetCommandOut): Promise<Outcome> {
    const { journal, supervisor } = this.deps;
    switch (command.type) {
      case 'ASSIGN': return this.assign(command);
      case 'CANCEL': {
        const outcome: Outcome = supervisor.cancel(command.jobId, command.leaseEpoch) === 'ok' ? { result: 'ok' } : { result: 'rejected', detail: 'does not hold job' };
        this.record(command, outcome);
        return outcome;
      }
      case 'ABANDON': {
        await supervisor.abandon(command.jobId, command.leaseEpoch);
        this.record(command, { result: 'ok' });
        return { result: 'ok' };
      }
      case 'READOPT': {
        const outcome = await supervisor.readopt(command.jobId, command.leaseEpoch);
        this.record(command, outcome);
        return outcome;
      }
      default: {
        const outcome: Outcome = { result: 'rejected', detail: 'unknown command type' };
        journal.recordCommand({ commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch, type: String(command.type), result: 'rejected', detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString() });
        return outcome;
      }
    }
  }

  /** D63: an ASSIGN that was journaled and acked, but whose run was lost in a restart, starts again (a no-op while a run exists). */
  private resumeStranded(jobId: string, leaseEpoch: number): void {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (row && row.state === 'ASSIGNED' && row.pid === null && row.doneAt === null) this.deps.supervisor.begin(row, 'reprepare');
  }

  private async assign(command: FleetCommandOut): Promise<Outcome> {
    const { journal, supervisor, workspaceRoot } = this.deps;
    const parsed = parseAssign(command);
    if (!parsed.ok) {
      const outcome: Outcome = { result: 'rejected', detail: parsed.detail };
      this.record(command, outcome);
      return outcome;
    }
    const { assign } = parsed;
    const inserted = journal.tx(() => {
      const result = journal.insertJob({ assign, leaseEpoch: command.leaseEpoch, repoKey: `${assign.repo.owner}/${assign.repo.name}`, jobDir: jobDirFor(workspaceRoot, assign.jobId) });
      this.record(command, { result: 'ok' });
      return result;
    });
    if (!inserted.created) {
      this.resumeStranded(assign.jobId, command.leaseEpoch);
      return { result: 'ok' };
    }
    // D64: the same job id at a lower epoch is the attempt this one replaces. Drop it (kill, reap and cleanup are left to this
    // epoch's prepare, which wipes the previous attempt's files, D53) BEFORE the new run can queue for the repo.
    for (const older of journal.jobsById(assign.jobId).filter((row) => row.leaseEpoch < command.leaseEpoch)) {
      await supervisor.abandon(assign.jobId, older.leaseEpoch);
    }
    supervisor.begin(inserted.row, 'prepare');
    return { result: 'ok' };
  }
}
