import { Inject, Injectable } from '@nestjs/common';
import type { ApprovalOption } from '../../common/protocol';
import { FleetCommandType } from '../../../common/enums';
import { currentContext } from '../../../action-context/action-context';
import { AuditRecorder } from '../../../audit/audit-recorder.service';
import { committedEffect } from '../../../common/committed-effects';
import type { ApprovalCommand } from '../../../approvals/approval-command.registry';
import { checkBashDecision } from '../bash-decision';
import { FleetApprovalAskStore } from '../fleet-approval-ask.store';
import { FLEET_JOB_REPOSITORY, type IFleetJobRepository } from '../../jobs/domain/fleet-job.domain';
import { RunnerNotifier } from '../../jobs/runner-notifier';

export interface BashAskInput { jobId: string; leaseEpoch: number; naxAskId: string; payload: Record<string, unknown> }
export interface BashDecision { choice: 'allow' | 'allow_for_job' | 'deny'; option: ApprovalOption }
export type BashResult = { answered: true; choice: BashDecision['choice'] } | { answered: false };

@Injectable()
export class FleetShellEscalateCommand implements ApprovalCommand<BashAskInput, BashResult, BashDecision> {
  readonly key = 'fleet.job.shell.escalate';

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById' | 'createCommand'>,
    private readonly asks: FleetApprovalAskStore,
    private readonly notifier: RunnerNotifier,
    private readonly audit: AuditRecorder,
  ) {}

  parse(input: unknown): BashAskInput {
    if (!isRecord(input) || typeof input.jobId !== 'string' || input.jobId.length === 0 ||
        typeof input.naxAskId !== 'string' || input.naxAskId.length === 0 ||
        typeof input.leaseEpoch !== 'number' || !Number.isInteger(input.leaseEpoch) || input.leaseEpoch < 0 ||
        !isPlainRecord(input.payload)) throw new Error('invalid bash ask input');
    return { jobId: input.jobId, leaseEpoch: input.leaseEpoch, naxAskId: input.naxAskId, payload: input.payload };
  }

  parseDecision(decision: 'approve' | 'reject', params: unknown, input: BashAskInput): BashDecision {
    if (decision === 'reject') {
      if (params !== undefined && (!isRecord(params) || params.choice !== 'deny')) throw new Error('invalid bash rejection');
      return { choice: 'deny', option: 'deny' };
    }
    let choice: 'allow' | 'allow_for_job';
    if (params === undefined) choice = 'allow';
    else {
      if (!isRecord(params) || (params.choice !== 'allow' && params.choice !== 'allow_for_job')) throw new Error('invalid bash approval');
      choice = params.choice;
    }
    const checked = checkBashDecision(input.payload, choice);
    if (checked.ok === false) throw new Error(checked.reason);
    return { choice, option: checked.choice };
  }

  async execute(input: BashAskInput, decision?: BashDecision): Promise<BashResult> {
    if (!decision) throw new Error('bash approval decision is required');
    return this.answer(input, decision);
  }

  async onReject(input: BashAskInput, decision: BashDecision | undefined): Promise<void> {
    if (!decision) throw new Error('bash rejection decision is required');
    await this.answer(input, decision);
  }

  toResult(result: BashResult): BashResult { return result; }

  private async answer(input: BashAskInput, decision: BashDecision): Promise<BashResult> {
    const requestId = currentContext()?.approval?.requestId;
    if (!requestId) throw new Error('fleet ask needs its request id');
    const job = await this.jobs.lockById(input.jobId);
    // US-004 adds the lease/state guard. US-003 writes for every existing job.
    if (!job || job.runnerId === null) throw new Error('bash ask job is unavailable');
    const runnerId = job.runnerId;
    await this.jobs.createCommand({
      runnerId, jobId: job.id, type: FleetCommandType.APPROVAL_ANSWER, leaseEpoch: input.leaseEpoch,
      payload: { approvalId: requestId, naxAskId: input.naxAskId, choice: decision.option },
    });
    await this.audit.record({ key: this.key, resourceType: 'fleet-approval', resourceId: requestId, projectId: job.projectId, summary: `answered ${decision.option}` });
    committedEffect(() => this.notifier.notify(runnerId));
    return { answered: true, choice: decision.choice };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
