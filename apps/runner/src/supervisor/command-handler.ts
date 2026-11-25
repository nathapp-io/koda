import type { CommandAck, FleetCommandOut } from '@nathapp/fleet-protocol';
import type { ApprovalRelay } from '../approvals/approval-relay';
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
  readonly approvals: Pick<ApprovalRelay, 'answer'>;
  /**
   * review-1118 US-001: test-only. It admits an `http:` or `file:` clone URL in an ASSIGN; production
   * (`DaemonOptions` unset by `main.ts` and `commands/run.ts`) keeps every job on `https:`.
   */
  readonly allowLocalCloneUrls?: boolean;
  /**
   * US-001: an ack whose command is still retiring is offered here once its outcome is durable. The daemon hands it
   * to the sync loop, which carries it on a later request. Absent: the ack is dropped (the server redelivers).
   */
  readonly onDeferredAck?: (ack: CommandAck) => void;
}

type Outcome = { result: 'ok' | 'rejected'; detail?: string };

/** TYPE-2: a fixed literal for any command type we did not recognise, so the journal never stores String(number). */
const UNKNOWN_COMMAND_TYPE = 'unknown';

/** Turns server commands into acks (design §1.3). Every applied command is recorded so a re-sent one is acked, not re-run. */
export class CommandHandler {
  /** US-001: the ABANDON retirements in flight, by command id; a repeated command joins the first one. */
  private readonly retirements = new Map<string, Promise<void>>();

  constructor(private readonly deps: CommandHandlerDeps) {}

  /**
   * US-001: a command whose retirement is still running has no ack yet: the ack comes when its outcome is durable.
   * The other commands answer as before.
   */
  async handle(commands: readonly FleetCommandOut[]): Promise<CommandAck[]> {
    const acks: CommandAck[] = [];
    for (const command of commands) {
      const ack = await this.handleOne(command);
      if (ack) acks.push(ack);
    }
    return acks;
  }

  /** US-001: the retirements still running. The daemon joins them before it closes the journal. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.retirements.values()]);
  }

  private ack(command: FleetCommandOut, outcome: Outcome): CommandAck {
    return { commandId: command.commandId, leaseEpoch: command.leaseEpoch, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }

  private record(command: FleetCommandOut, outcome: Outcome): void {
    this.recordAs(command, String(command.type), outcome);
  }

  private recordAs(command: FleetCommandOut, type: string, outcome: Outcome): void {
    this.deps.journal.recordCommand({
      commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch, type,
      result: outcome.result, detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString(),
    });
  }

  /**
   * B2: the durable write of a re-applied READOPT. `Supervisor.readopt` calls it with a rejection INSIDE the journal
   * transaction that sets the row's `doneAt`, so the two commit together and a crash leaves neither behind: the record
   * stays `ok` and the row stays open, which makes the next boot re-apply the command instead of replaying stale ok.
   */
  private persistOutcome(command: FleetCommandOut): (outcome: Outcome) => void {
    return (outcome) => this.deps.journal.updateCommandOutcome(command.commandId, {
      result: outcome.result, detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString(),
    });
  }

  private async handleOne(command: FleetCommandOut): Promise<CommandAck | null> {
    const prior = this.deps.journal.getCommand(command.commandId);
    if (prior) {
      if (prior.type === 'ASSIGN' && prior.result === 'ok') this.resumeStranded(prior.jobId, prior.leaseEpoch);
      if (prior.type === 'READOPT' && prior.result === 'ok') {
        const row = this.deps.journal.getJob(prior.jobId, prior.leaseEpoch);
        if (row && row.doneAt === null) {
          // K10/B2: the re-applied readopt's outcome is journaled inside the transaction that finalizes a rejected
          // row (see `persistOutcome`), so a crash cannot preserve the previous `ok` beside a done row — the replay
          // that follows then acks the rejection, and the API marks the job CRASHED instead of recording it adopted.
          const persist = this.persistOutcome(command);
          try {
            const outcome = await this.deps.supervisor.readopt(prior.jobId, prior.leaseEpoch, persist);
            persist(outcome);   // the ok path writes nothing else; a rejection is already stored (idempotent re-write)
            return this.ack(command, outcome);
          } catch {
            return this.ack(command, { result: 'rejected', detail: 'runner error' });
          }
        }
      }
      return this.ack(command, { result: prior.result, ...(prior.detail ? { detail: prior.detail } : {}) });
    }
    // US-001: the command is already retiring. Its ack comes when the retirement's outcome is durable.
    if (this.retirements.has(command.commandId)) return null;
    let outcome: Outcome | null;
    try {
      outcome = await this.apply(command);
    } catch (error) {
      this.deps.log.error('command failed', { commandId: command.commandId, type: command.type, error: errorMessage(error) });
      return this.ack(command, { result: 'rejected', detail: 'runner error' });
    }
    if (outcome === null) return null;
    return this.ack(command, outcome);
  }

  /**
   * US-001: the ABANDON's retirement. The target is halted at once (the supervisor starts the retirement
   * synchronously), the cleanup waits for the repo mutex off the polling path, and the outcome is persisted before
   * the ack is offered. A repeated command id joins this retirement: one cleanup, one ack.
   */
  private beginRetirement(command: FleetCommandOut): void {
    if (this.retirements.has(command.commandId)) return;
    const promise: Promise<void> = this.runRetirement(command).finally(() => {
      this.retirements.delete(command.commandId);
    });
    this.retirements.set(command.commandId, promise);
  }

  private async runRetirement(command: FleetCommandOut): Promise<void> {
    let outcome: Outcome;
    try {
      await this.deps.supervisor.retire(command.jobId, command.leaseEpoch);
      outcome = { result: 'ok' };
    } catch (error) {
      this.deps.log.error('abandon failed', { commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch, error: errorMessage(error) });
      outcome = { result: 'rejected', detail: 'runner error' };
    }
    let persisted: Outcome;
    try {
      persisted = this.recordOutcome(command, outcome);
    } catch (error) {
      // US-001: without a durable outcome there is no ack. The in-flight entry is cleared and the server redelivers,
      // so the command runs again instead of being lost.
      this.deps.log.error('abandon outcome could not be persisted', { commandId: command.commandId, error: errorMessage(error) });
      return;
    }
    this.offerAck(command, persisted);
  }

  /** The deferred ack never rejects the retirement: a sink that fails is reported, not thrown. */
  private offerAck(command: FleetCommandOut, outcome: Outcome): void {
    try {
      this.deps.onDeferredAck?.(this.ack(command, outcome));
    } catch (error) {
      this.deps.log.error('abandon ack could not be offered', { commandId: command.commandId, error: errorMessage(error) });
    }
  }

  /**
   * US-001: the ABANDON's durable outcome. A recorded rejection is never turned into a success by a later delivery,
   * so the journal's own record decides the ack.
   */
  private recordOutcome(command: FleetCommandOut, outcome: Outcome): Outcome {
    const prior = this.deps.journal.getCommand(command.commandId);
    if (prior) return { result: prior.result, ...(prior.detail ? { detail: prior.detail } : {}) };
    this.record(command, outcome);
    const stored = this.deps.journal.getCommand(command.commandId);
    return stored ? { result: stored.result, ...(stored.detail ? { detail: stored.detail } : {}) } : outcome;
  }

  private async apply(command: FleetCommandOut): Promise<Outcome | null> {
    const { supervisor } = this.deps;
    switch (command.type) {
      case 'ASSIGN': return this.assign(command);
      case 'CANCEL': {
        // Finding 8 (US-006): the supervisor's decision says whether the cancel was accepted, or refused because the
        // job has passed the upload cutoff — a refused cancellation is never acked ok for a job that then finishes on
        // its own verdict. A replay is answered from the record above, before this path.
        const decision = supervisor.cancel(command.jobId, command.leaseEpoch);
        const outcome: Outcome = decision === 'ok'
          ? { result: 'ok' }
          : { result: 'rejected', detail: decision === 'refused' ? 'cancel cutoff passed' : 'does not hold job' };
        this.record(command, outcome);
        return outcome;
      }
      case 'ABANDON': {
        // US-001: the retirement runs outside the poll, so a job that waits for a token is served while it waits.
        this.beginRetirement(command);
        return null;
      }
      case 'READOPT': {
        const outcome = await supervisor.readopt(command.jobId, command.leaseEpoch);
        this.record(command, outcome);
        return outcome;
      }
      case 'APPROVAL_ANSWER': {
        // Spec §4.4 / plan D276: inline, bounded by the 10 s callback deadline; recorded so a re-sent command is not re-POSTed.
        const outcome = await this.deps.approvals.answer(command);
        this.record(command, outcome);
        return outcome;
      }
      // Fleet S5a §4: every THREAD command reaches the thread run that holds the (job, epoch); the ack is
      // recorded, so a re-sent command id is answered from the record and never applied twice.
      case 'THREAD_INPUT':
      case 'THREAD_ANSWER':
      case 'THREAD_STOP_TURN':
      case 'THREAD_CLOSE':
      case 'THREAD_PUBLISH': {
        const outcome: Outcome = await supervisor.threadCommand(command);
        this.record(command, outcome);
        return outcome;
      }
      default: {
        const outcome: Outcome = { result: 'rejected', detail: 'unknown command type' };
        this.recordAs(command, UNKNOWN_COMMAND_TYPE, outcome);
        return outcome;
      }
    }
  }

  /**
   * D63: an ASSIGN that was journaled and acked, but whose run was lost in a restart, starts again (a no-op while a
   * run exists). B1: `begin` rebuilds the older-epoch retirement this restart lost, so the replayed epoch still starts
   * only after any older epoch of the job is gone.
   */
  private resumeStranded(jobId: string, leaseEpoch: number): void {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (row && row.state === 'ASSIGNED' && row.pid === null && row.doneAt === null) this.deps.supervisor.begin(row, 'reprepare');
  }

  private async assign(command: FleetCommandOut): Promise<Outcome> {
    const { journal, supervisor, workspaceRoot } = this.deps;
    const parsed = parseAssign(command, { allowLocalCloneUrls: this.deps.allowLocalCloneUrls === true });
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
    // D64/K11: the same job id at a lower epoch is the attempt this one replaces. The older epoch must be gone before
    // this epoch's prepare, but the abandon may wait on the repo mutex (another job's long run), so it is retired in the
    // background and this run waits for it instead of the sync loop (which awaits this handler) waiting here.
    supervisor.begin(inserted.row, 'prepare', supervisor.retireOlderEpochs(assign.jobId, command.leaseEpoch));
    return { result: 'ok' };
  }
}
