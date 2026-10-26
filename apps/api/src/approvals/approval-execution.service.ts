import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { runWithActionContext, type ActionApproval, type ActionContextInput } from '../action-context/action-context';
import { bookkeeping } from '../action-context/audit-coverage';
import { PermissionService } from '../permissions/permission.service';
import { ApprovalCommandRegistry, type ApprovalCommand } from './approval-command.registry';
import { canonicalJson } from './canonical-json';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { ApprovalRequestEvents } from './approval-request-events';

const OWN_SUFFIX = '.own';

/** The pre-check outcomes that settle a request as failed before its command is run. */
type PrecheckFailure = 'no-command' | 'input-hash-mismatch' | 'permission-revoked' | 'invalid-input';

/** A pre-check pass hands the command and its parsed input on, so `parse` runs once at execution. */
type Prechecked =
  | { ok: true; command: ApprovalCommand; parsed: unknown }
  | { ok: false; error: PrecheckFailure };

/**
 * P3 approval core (US-011): runs the frozen command of an approved request exactly once, under the
 * context the request was opened in, and settles the request in the same transaction as the command's
 * own writes.
 *
 * Decide and execute are separate transactions: the approval is on record before this runs, so a
 * failing command marks the request `failed` instead of losing the decision.
 */
@Injectable()
export class ApprovalExecutionService {
  private readonly logger = new Logger(ApprovalExecutionService.name);
  /** The tail of each request's in-flight run; entries are removed when the last waiter finishes. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly requests: PrismaApprovalRequestRepository,
    private readonly permissions: PermissionService,
    private readonly registry: ApprovalCommandRegistry,
    private readonly events: ApprovalRequestEvents,
  ) {}

  async execute(requestId: string, now: Date = new Date()): Promise<ApprovalRequestRecord> {
    const request = await this.requests.findById(requestId);
    if (!request) throw new ApprovalRequestNotFoundError(requestId);
    if (request.status !== 'approved') throw new ApprovalRequestNotPendingError(request.status);

    // Every write below, the settle rows included, runs as the request's actor: the caller's own
    // context (the decider's, or none for a direct call) is not the one the command was asked under.
    const context = requestContext(request);
    return runWithActionContext(context, async () => {
      const checked = await this.precheck(request);
      if (checked.ok === false) return this.settle(request.id, { status: 'failed', settledAt: now, result: { error: checked.error } });

      return this.run(request, checked.command, checked.parsed, now);
    });
  }

  private async precheck(request: ApprovalRequestRecord): Promise<Prechecked> {
    const command = this.registry.get(request.permissionKey);
    if (command === undefined) return { ok: false, error: 'no-command' };

    const hash = createHash('sha256').update(canonicalJson(request.input), 'utf8').digest('hex');
    if (hash !== request.inputHash) return { ok: false, error: 'input-hash-mismatch' };

    if (!(await this.stillHoldsKey(request))) return { ok: false, error: 'permission-revoked' };

    try {
      return { ok: true, command, parsed: command.parse(request.input) };
    } catch {
      return { ok: false, error: 'invalid-input' };
    }
  }

  /**
   * The key-only re-check: the principal the action belongs to must still hold the key (or its
   * `.own` form) at the request's scope. Row ownership and domain rules are the command's business.
   */
  private async stillHoldsKey(request: ApprovalRequestRecord): Promise<boolean> {
    const principal = recheckPrincipal(request);
    if (principal === null) return false;

    const scope = request.projectId === null ? 'global' : { projectId: request.projectId };
    const keys = await this.permissions.effectiveKeys(principal, scope);
    return keys.has(request.permissionKey) || keys.has(`${request.permissionKey}${OWN_SUFFIX}`);
  }

  /**
   * Step 3 and 4. Only a failure of the callback is turned into a `failed` request: once the callback
   * has returned, a failing commit is reported to the caller and the request stays approved.
   */
  private async run(request: ApprovalRequestRecord, command: ApprovalCommand, parsed: unknown, now: Date): Promise<ApprovalRequestRecord> {
    // The row lock is released when the failed callback rolls back, before the failure settlement
    // opens its own transaction. Holding this request's slot across both keeps a waiting execute from
    // taking the still-approved row in that gap and running the command a second time.
    return this.serialised(request.id, async () => {
      // Set only when the callback itself threw: a transaction that fails to open, or to commit after
      // the callback succeeded, is reported to the caller and never settles the request.
      let callbackFailure: { error: unknown } | undefined;
      try {
        return await this.txManager.run(async () => {
          try {
            const locked = await this.requests.lockById(request.id);
            if (!locked) throw new ApprovalRequestNotFoundError(request.id);
            if (locked.status !== 'approved') throw new ApprovalRequestNotPendingError(locked.status);

            const result = await command.execute(parsed);
            const settled = await bookkeeping('approval.request-settle', () => this.requests.transition(request.id, 'approved', {
              status: 'executed', settledAt: now, result: command.toResult?.(result) ?? null,
            }));
            // The row is locked by this transaction, so a lost transition means a broken boundary: roll back.
            if (!settled) throw new ApprovalRequestNotPendingError(locked.status);
            await this.events.record(settled);

            return settled;
          } catch (error) {
            callbackFailure = { error };
            throw error;
          }
        });
      } catch (error) {
        if (callbackFailure === undefined || error instanceof ApprovalRequestNotPendingError) throw error;

        this.logger.warn(`approval request ${request.id} failed to execute: ${errorMessage(error)}`);
        return this.settle(request.id, {
          status: 'failed', settledAt: now, result: { error: 'execution-failed', name: errorName(error) },
        });
      }
    });
  }

  /** Runs `fn` after every earlier call for the same request id has finished (one API instance). */
  private async serialised<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.running.get(id) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.then(() => undefined, () => undefined);
    this.running.set(id, tail);
    try {
      return await current;
    } finally {
      if (this.running.get(id) === tail) this.running.delete(id);
    }
  }

  /** Settles an approved request in its own transaction as bookkeeping. */
  private async settle(id: string, patch: Pick<ApprovalRequestRecord, 'status' | 'settledAt' | 'result'>): Promise<ApprovalRequestRecord> {
    const settled = await bookkeeping('approval.request-settle', () => this.txManager.run(async () => {
      const transitioned = await this.requests.transition(id, 'approved', patch);
      if (transitioned) await this.events.record(transitioned);
      return transitioned;
    }));
    if (settled) return settled;

    // Another execute settled it first.
    const current = await this.requests.findById(id);
    if (!current) throw new ApprovalRequestNotFoundError(id);
    throw new ApprovalRequestNotPendingError(current.status);
  }
}

/** The principal whose authority is re-checked: the on-behalf-of one for the assistant, else the actor. */
function recheckPrincipal(request: ApprovalRequestRecord): { type: 'USER' | 'AGENT'; id: string } | null {
  const { actor, onBehalfOf } = request;
  if (actor.type === 'SYSTEM' && actor.id === 'assistant') return onBehalfOf;
  if (actor.type === 'USER' || actor.type === 'AGENT') return { type: actor.type, id: actor.id };
  return null;
}

/** The context the request was opened in, now carrying the approval that released it. */
function requestContext(request: ApprovalRequestRecord): ActionContextInput {
  const approval: ActionApproval = {
    requiredMode: request.requiredMode,
    satisfiedBy: request.satisfiedBy ?? 'none',
    ...(request.approverType !== null && request.approverId !== null
      ? { approverType: request.approverType, approverId: request.approverId } : {}),
    requestId: request.id,
  };
  return {
    actor: request.actor, origin: request.origin, correlationId: request.correlationId, approval,
    ...(request.onBehalfOf !== null ? { onBehalfOf: request.onBehalfOf } : {}),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
