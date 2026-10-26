import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { bookkeeping } from '../action-context/audit-coverage';
import { currentContext, runWithActionContext, type ActionApproval, type ActionContext } from '../action-context/action-context';
import { findCatalogEntry } from '../permissions/catalog';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { approvalInputHash, freezeApprovalInput } from './approval-input';
import { ApprovalPolicyResolver, type ApprovalSubject, type ResolvedApproval } from './approval-policy.resolver';
import {
  APPROVAL_REQUEST_REPOSITORY,
  DEFAULT_APPROVAL_TIMEOUT_SEC,
  type ApprovalRequestRecord,
} from './domain/approval.domain';
import { UnregisteredApprovalCommandError } from './domain/approval.errors';
import type { PendingApprovalMatch, PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

export type GateOutcome<TResult> =
  | { status: 'executed'; result: TResult; approval: ActionApproval }
  | { status: 'pending'; request: ApprovalRequestRecord };

/** No policy names a setting, so the request carries these (the catalog has no per-key defaults). */
const NO_POLICY_ON_TIMEOUT: ApprovalRequestRecord['onTimeout'] = 'reject';

/** The gate's request seam: the duplicate lookup and the insert of one pending request. */
type RequestStore = Pick<PrismaApprovalRequestRepository, 'create' | 'findPendingDuplicate'>;

@Injectable()
export class ApprovalGate {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    @Inject(ApprovalPolicyResolver) private readonly resolver: Pick<ApprovalPolicyResolver, 'resolve'>,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly requests: RequestStore,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async gate<TResult>(
    key: string,
    input: unknown,
    opts: { projectId: string | null },
    now?: Date,
  ): Promise<GateOutcome<TResult>> {
    const command = this.registry.get(key);
    if (command === undefined) throw new UnregisteredApprovalCommandError(key);

    const context = currentContext();
    if (context === undefined) throw new Error('approval gate needs an action context');

    const { actor } = context;
    let subject: ApprovalSubject;
    // The actor the request row attributes the ask to: the subject's principal for USER/AGENT, and
    // the system component for the assistant (which acts on behalf of a principal).
    let requestActorType: ApprovalRequestRecord['actor']['type'];
    if (actor.type === 'USER' || actor.type === 'AGENT') {
      subject = { type: actor.type, id: actor.id };
      requestActorType = actor.type;
    } else if (actor.type === 'SYSTEM' && actor.id === 'assistant' && context.onBehalfOf !== undefined) {
      subject = { type: 'ASSISTANT', id: 'assistant' };
      requestActorType = 'SYSTEM';
    } else {
      throw new Error(`approval gate cannot gate actor ${actor.type}/${actor.id}`);
    }

    const parsed = command.parse(input);
    if (parsed === undefined || parsed === null) throw new Error(`approval command parse returned no input: ${key}`);
    if (findCatalogEntry(key)?.scope === 'project' && opts.projectId === null) {
      throw new Error(`approval gate needs a project for key ${key}`);
    }

    const resolved = await this.resolver.resolve({ key, projectId: opts.projectId, subject });
    let approval: ActionApproval;
    if (resolved.mode === 'none') {
      approval = { requiredMode: 'none', satisfiedBy: 'none' };
    } else if (subject.type === 'USER') {
      // Direct humans satisfy every mode, regardless of request-decision policy flags.
      approval = { requiredMode: resolved.mode, satisfiedBy: 'human', approverType: 'USER', approverId: actor.id };
    } else {
      const request = await this.openRequest(
        { key, projectId: opts.projectId, parsed, resolved, context, actorType: requestActorType },
        now ?? new Date(),
      );
      return { status: 'pending', request };
    }

    const result = await runWithActionContext({ ...context, approval }, () => command.execute(parsed));
    // The registry erases result types; the caller chooses TResult for its registered command.
    return { status: 'executed', result: result as TResult, approval };
  }

  /**
   * Step 7 of the gate: the request a non-human call waits on. A still-pending request for the same
   * actor, on-behalf-of principal, key, project and frozen input is that request — an agent that
   * retries gets the one it already opened instead of flooding the inbox. Two identical calls racing
   * each other can still open two (check-then-insert, no unique index); each is then decided on its
   * own.
   */
  private async openRequest(
    opened: {
      key: string;
      projectId: string | null;
      parsed: unknown;
      resolved: ResolvedApproval;
      context: ActionContext;
      actorType: ApprovalRequestRecord['actor']['type'];
    },
    now: Date,
  ): Promise<ApprovalRequestRecord> {
    const { key, projectId, parsed, resolved, context, actorType } = opened;
    const inputHash = approvalInputHash(parsed);
    const duplicate: PendingApprovalMatch = {
      actorType,
      actorId: context.actor.id,
      onBehalfOfType: context.onBehalfOf?.type ?? null,
      onBehalfOfId: context.onBehalfOf?.id ?? null,
      permissionKey: key,
      projectId,
      inputHash,
    };

    const pending = await this.requests.findPendingDuplicate(duplicate, now);
    if (pending !== null) return pending;

    // The ApprovalRequest row is itself the record of the ask, so opening it is bookkeeping: no
    // audit entry, and the write does not count against the entry point's audit coverage.
    return bookkeeping('approval.request-open', () => this.txManager.run(async () => this.requests.create(
      newRequest({ ...opened, inputHash }, now),
    )));
  }
}

/**
 * The row an open writes. The policy's settings are copied, not referenced: a later policy edit
 * leaves this request's mode, timeout and flags as they were when the caller was asked.
 */
function newRequest(
  opened: {
    key: string;
    projectId: string | null;
    parsed: unknown;
    resolved: ResolvedApproval;
    context: ActionContext;
    actorType: ApprovalRequestRecord['actor']['type'];
    inputHash: string;
  },
  now: Date,
): ApprovalRequestRecord {
  const { key, projectId, parsed, resolved, context, actorType, inputHash } = opened;
  const { policy } = resolved;
  const timeoutSec = policy?.timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC;

  return {
    id: randomUUID(),
    permissionKey: key,
    projectId,
    actor: { type: actorType, id: context.actor.id },
    onBehalfOf: context.onBehalfOf ?? null,
    origin: context.origin,
    correlationId: context.correlationId,
    input: freezeApprovalInput(parsed),
    inputHash,
    requiredMode: resolved.mode,
    policyId: policy?.id ?? null,
    onTimeout: policy?.onTimeout ?? NO_POLICY_ON_TIMEOUT,
    approverMustHoldAction: policy?.approverMustHoldAction ?? true,
    requireDistinctApprover: policy?.requireDistinctApprover ?? false,
    status: 'pending',
    satisfiedBy: null,
    approverType: null,
    approverId: null,
    expiresAt: new Date(now.getTime() + timeoutSec * 1000),
    decidedAt: null,
    settledAt: null,
    result: null,
    createdAt: now,
  };
}
