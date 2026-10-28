import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext } from '../action-context/action-context';
import { bookkeeping } from '../action-context/audit-coverage';
import { findCatalogEntry } from '../permissions/catalog';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { approvalInputHash, freezeApprovalInput } from './approval-input';
import { ApprovalPolicyResolver, type ApprovalSubject, type ResolvedApproval } from './approval-policy.resolver';
import { ApprovalRequestEvents } from './approval-request-events';
import {
  APPROVAL_REQUEST_REPOSITORY,
  DEFAULT_APPROVAL_TIMEOUT_SEC,
  type ApprovalRequestRecord,
} from './domain/approval.domain';
import { ApprovalRequestNotPendingError, UnregisteredApprovalCommandError } from './domain/approval.errors';
import type { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

/**
 * Permissions P3 approval core (US-006): the asks the system raises for itself.
 *
 * A bash escalation arrives in a runner report and a budget override is opened when spend crosses a
 * hard stop, so neither is chosen by a principal: `ApprovalGate` refuses every `SYSTEM` actor but the
 * assistant, and an ask must not run its command when no approval is needed (the fleet caller answers
 * the ask itself). `open` therefore resolves the policy, and writes only a pending request.
 *
 * It joins the caller's transaction — the fleet callers already hold the job or budget policy lock
 * (S1.5 lock order) and a nested `txManager.run` that throws would poison the outer one — so nothing
 * here opens one, and a caller outside a transaction is a programming error.
 */
export interface OpenAsk {
  key: string;                                         // a registered command's key
  projectId: string | null;
  component: string;                                   // the SYSTEM actor id: 'runner' | 'budget'
  onBehalfOf: { type: 'USER' | 'AGENT'; id: string } | null;
  origin: 'runner' | 'system';
  input: unknown;                                      // parsed with the command's `parse`
  deadline: Date | null;                               // caps expiresAt
}

export type AskOutcome<TInput = unknown> =
  | { status: 'not-needed'; input: TInput }
  | { status: 'pending'; request: ApprovalRequestRecord };

/**
 * The one key each system component raises. An ask skips the key re-check an execution runs for a
 * principal, so pinning the pair is what keeps a system-raised request to the two fleet asks.
 */
export const ASK_KEYS_BY_COMPONENT: Readonly<Record<string, string>> = {
  runner: 'fleet.job.shell.escalate',
  budget: 'fleet.budget.override',
};

/**
 * The request an ask writes. `onTimeout` is always `reject`: the deadline belongs to the asker (nax
 * denies its own bash ask, a budget pause outlives any timeout), so an ask never approves on timeout
 * whatever the policy says.
 */
@Injectable()
export class ApprovalAskService {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    @Inject(ApprovalPolicyResolver) private readonly resolver: Pick<ApprovalPolicyResolver, 'resolve'>,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly requests: Pick<PrismaApprovalRequestRepository, 'create' | 'lockByIdSkipLocked' | 'transition'>,
    private readonly events: ApprovalRequestEvents,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Inside the caller's transaction. De-duplication is the fleet link's (job, lease epoch, ask id). */
  async open<TInput>(ask: OpenAsk, now: Date = new Date()): Promise<AskOutcome<TInput>> {
    if (!this.txManager.isInTransaction()) {
      throw new Error("approval ask needs the caller's transaction");
    }

    const command = this.registry.get(ask.key);
    if (command === undefined) throw new UnregisteredApprovalCommandError(ask.key);
    if (ASK_KEYS_BY_COMPONENT[ask.component] !== ask.key) {
      throw new Error(`approval ask key ${ask.key} is not raised by ${ask.component}`);
    }
    if (findCatalogEntry(ask.key)?.scope === 'project' && ask.projectId === null) {
      throw new Error(`approval ask needs a project for key ${ask.key}`);
    }

    const parsed = command.parse(ask.input) as TInput;
    // The ask's subject is the principal it is on behalf of, or the component itself (which matches
    // project and pattern policies only, like the rank-3 rule, and never a role or principal policy).
    const subject: ApprovalSubject = ask.onBehalfOf ?? { type: 'SYSTEM', id: ask.component };
    const resolved = await this.resolver.resolve({ key: ask.key, projectId: ask.projectId, subject });
    if (resolved.mode === 'none') return { status: 'not-needed', input: parsed };

    // The ApprovalRequest row is itself the record of the ask: opening it is bookkeeping, and it is
    // written in the caller's transaction so the request commits with the job or budget change.
    const request = await bookkeeping('approval.request-open', async () => {
      const created = await this.requests.create(newAsk(ask, parsed, resolved, now));
      await this.events.record(created);
      return created;
    });

    return { status: 'pending', request };
  }

  /**
   * Inside the caller's transaction; null when the request is gone, not pending, or held by an
   * in-flight decide or execute.
   *
   * A fleet close holds the job's or the budget policy's lock first, while the engine's decide and
   * execute lock the request first and take that same job or policy lock from the command. To keep
   * the two orders from deadlocking, the request is taken with `FOR UPDATE SKIP LOCKED`: a held
   * request is being decided or executed, so it will not stay pending in the normal case and
   * skipping the close is the right outcome. The holder rolling back (a refused decide) leaves the
   * request pending; a bash ask then expires at its deadline.
   */
  async close(
    requestId: string,
    close: { status: 'cancelled' | 'expired'; reason: string },
    now: Date = new Date(),
  ): Promise<ApprovalRequestRecord | null> {
    if (!this.txManager.isInTransaction()) {
      throw new Error("approval ask needs the caller's transaction");
    }

    const locked = await this.requests.lockByIdSkipLocked(requestId);
    if (!locked || locked.status !== 'pending') return null;
    if (locked.actor.type !== 'SYSTEM' || locked.actor.id === 'assistant') {
      throw new Error('approval ask close: not an ask');
    }
    if (close.reason.length === 0 || close.reason.length > 64) {
      throw new Error('approval ask close: invalid reason');
    }

    return bookkeeping('approval.request-settle', async () => {
      const settled = await this.requests.transition(locked.id, 'pending', {
        status: close.status,
        settledAt: now,
        result: { closedBy: close.reason },
      });
      if (!settled) throw new ApprovalRequestNotPendingError(locked.status);
      await this.events.record(settled);
      return settled;
    });
  }
}

function newAsk(ask: OpenAsk, parsed: unknown, resolved: ResolvedApproval, now: Date): ApprovalRequestRecord {
  const { policy } = resolved;
  const timeoutSec = policy?.timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC;
  // Freeze once: the snapshot the row stores is exactly the value the hash describes.
  const input = freezeApprovalInput(parsed);

  return {
    id: randomUUID(),
    permissionKey: ask.key,
    // An ask carries no variant: it runs the key's primary command, never a REST route's variant, so
    // the two fleet asks keep the one command they registered.
    projectId: ask.projectId,
    actor: { type: 'SYSTEM', id: ask.component },
    onBehalfOf: ask.onBehalfOf,
    origin: ask.origin,
    correlationId: currentContext()?.correlationId ?? randomUUID(),
    input,
    inputHash: approvalInputHash(input),
    requiredMode: resolved.mode,
    policyId: policy?.id ?? null,
    onTimeout: 'reject',
    approverMustHoldAction: policy?.approverMustHoldAction ?? true,
    requireDistinctApprover: policy?.requireDistinctApprover ?? false,
    status: 'pending',
    satisfiedBy: null,
    approverType: null,
    approverId: null,
    expiresAt: expiresAt(now, timeoutSec, ask.deadline),
    decidedAt: null,
    settledAt: null,
    result: null,
    createdAt: now,
  };
}

/**
 * The earlier of the policy's (or the engine's) timeout and the asker's deadline. A deadline at or
 * before `now` still opens the request at that deadline; the sweeper expires it on its next tick.
 */
function expiresAt(now: Date, timeoutSec: number, deadline: Date | null): Date {
  const timeout = now.getTime() + timeoutSec * 1000;
  return new Date(deadline === null ? timeout : Math.min(timeout, deadline.getTime()));
}
