import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { bookkeeping } from '../action-context/audit-coverage';
import { currentContext, runWithActionContext, type ActionApproval, type ActionContext } from '../action-context/action-context';
import { findCatalogEntry } from '../permissions/catalog';
import { ApprovalRequestEvents } from './approval-request-events';
import { ApprovalCommandRegistry } from './approval-command.registry';
import type { ApprovalCommand } from './approval-command.registry';
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

/**
 * The input a request stores and hashes for `command`, before it is frozen (US-001 of `gate-secret`).
 *
 * A command with no `redeem`, or a redeem command with no `redact`, stores its parsed input whole. A
 * declared `redact` answers the stored form — the input minus its secrets — and a `redact` that
 * answers nothing is a broken redaction: it throws rather than letting the secret through, so neither
 * the row nor the hash ever carries it. The gate and `ApprovalExecutionService.redeem` both use this,
 * so the hash a redemption compares against is the hash the gate wrote.
 */
export function redeemStored(command: Pick<ApprovalCommand, 'key' | 'redeem'>, parsed: unknown): unknown {
  const redact = command.redeem?.redact;
  if (redact === undefined) return parsed;

  const stored = redact(parsed);
  if (stored === null || stored === undefined) {
    throw new Error(`approval redeem redact returned no input: ${command.key}`);
  }

  return stored;
}

@Injectable()
export class ApprovalGate {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    @Inject(ApprovalPolicyResolver) private readonly resolver: Pick<ApprovalPolicyResolver, 'resolve'>,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly requests: RequestStore,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly events: ApprovalRequestEvents,
  ) {}

  async gate<TResult>(
    key: string,
    input: unknown,
    opts: { projectId: string | null; variant?: string },
    now?: Date,
  ): Promise<GateOutcome<TResult>> {
    const command = this.registry.get(key, opts.variant);
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
        { command, key, projectId: opts.projectId, variant: opts.variant, parsed, resolved, context, actorType: requestActorType },
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
   * actor, on-behalf-of principal, key, variant, project and frozen input is that request — an agent
   * that retries gets the one it already opened instead of flooding the inbox. Two identical calls
   * racing each other can still open two (check-then-insert, no unique index); each is then decided
   * on its own.
   */
  private async openRequest(
    opened: {
      /** The command the request runs; its `redeem` decides what is stored and the record's flag. */
      command: ApprovalCommand;
      key: string;
      projectId: string | null;
      /** The command's variant (US-001): absent for the key's primary command. */
      variant: string | undefined;
      parsed: unknown;
      resolved: ResolvedApproval;
      context: ActionContext;
      actorType: ApprovalRequestRecord['actor']['type'];
    },
    now: Date,
  ): Promise<ApprovalRequestRecord> {
    const { command, key, projectId, variant, resolved, context, actorType } = opened;
    // Freeze once: the snapshot the row stores is exactly the value the hash describes. A redeem
    // command stores and hashes its redacted input, so neither the row nor the hash carries a secret.
    const input = freezeApprovalInput(redeemStored(command, opened.parsed));
    const inputHash = approvalInputHash(input);
    const duplicate: PendingApprovalMatch = {
      actorType,
      actorId: context.actor.id,
      onBehalfOfType: context.onBehalfOf?.type ?? null,
      onBehalfOfId: context.onBehalfOf?.id ?? null,
      permissionKey: key,
      projectId,
      inputHash,
      // The pair, not the key: a variant of the same key with the same input is a different ask.
      variant: variant ?? null,
    };

    const pending = await this.requests.findPendingDuplicate(duplicate, now);
    if (pending !== null) return pending;

    // The ApprovalRequest row is itself the record of the ask, so opening it is bookkeeping: no
    // audit entry, and the write does not count against the entry point's audit coverage.
    return bookkeeping('approval.request-open', () => this.txManager.run(async () => {
      const created = await this.requests.create(
        newRequest({ command, key, projectId, variant, resolved, context, actorType, input, inputHash }, now),
      );
      await this.events.record(created);
      return created;
    }));
  }
}

/**
 * The row an open writes. The policy's settings are copied, not referenced: a later policy edit
 * leaves this request's mode, timeout and flags as they were when the caller was asked. `input` is
 * the frozen snapshot its `inputHash` was computed from.
 */
function newRequest(
  opened: {
    command: ApprovalCommand;
    key: string;
    projectId: string | null;
    variant: string | undefined;
    resolved: ResolvedApproval;
    context: ActionContext;
    actorType: ApprovalRequestRecord['actor']['type'];
    input: unknown;
    inputHash: string;
  },
  now: Date,
): ApprovalRequestRecord {
  const { command, key, projectId, variant, resolved, context, actorType, input, inputHash } = opened;
  const { policy } = resolved;
  const timeoutSec = policy?.timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC;

  return {
    id: randomUUID(),
    permissionKey: key,
    // Absent, never `undefined`: the record doubles as the null-variant check its readers rely on.
    ...(variant === undefined ? {} : { variant }),
    // Absent unless the command redeems: the record doubles as the false check its readers rely on.
    ...(command.redeem === undefined ? {} : { redeem: true as const }),
    projectId,
    actor: { type: actorType, id: context.actor.id },
    onBehalfOf: context.onBehalfOf ?? null,
    origin: context.origin,
    correlationId: context.correlationId,
    input,
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
