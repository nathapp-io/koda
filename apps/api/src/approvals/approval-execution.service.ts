import { createHash } from 'node:crypto';
import { withCommittedEffects } from '../common/committed-effects';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, runWithActionContext, type ActionApproval, type ActionContextInput } from '../action-context/action-context';
import { bookkeeping } from '../action-context/audit-coverage';
import { holdsNarrowedDecide, PermissionService } from '../permissions/permission.service';
import { AfterCommitService } from '../permissions/after-commit.service';
import { ApprovalCommandRegistry, type ApprovalCommand } from './approval-command.registry';
import { redeemStored } from './approval-gate.service';
import { approvalInputHash } from './approval-input';
import { canonicalJson } from './canonical-json';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import {
  ApprovalRedeemMismatchError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError,
} from './domain/approval.errors';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { ApprovalRequestEvents } from './approval-request-events';

const OWN_SUFFIX = '.own';

/**
 * What a requester sends to redeem an approved redeem request (US-004 of `gate-secret`): the pair it
 * was opened for, its project, and the full body the call would have sent without an approval.
 */
export interface RedeemCall {
  key: string;
  variant?: string;
  projectId: string | null;
  input: unknown;
}

/**
 * What `run` answers: the request it settled, the command's raw result (kept for the follow-up hook,
 * which the `toResult` projection does not carry), and — when the command's own work failed — the
 * error it threw. `execute` maps this back to the request alone; a redemption answers the error.
 */
interface RunOutcome {
  settled: ApprovalRequestRecord;
  raw?: { result: unknown };
  failure?: { error: unknown };
}

/** The pre-check outcomes that settle a request as failed before its command is run. */
type PrecheckFailure = 'no-command' | 'input-hash-mismatch' | 'permission-revoked' | 'invalid-input' | 'invalid-decision';

/**
 * What `recheckPrincipal` answers: the principal whose key is re-checked, `'skip'` for a system ask
 * that has no principal behind it, or `null` when there is nothing to check.
 */
type RecheckPrincipal = { type: 'USER' | 'AGENT'; id: string } | 'skip' | null;

/**
 * A pre-check pass hands the command, its parsed input and the approving decision's parsed params on,
 * so `parse` and `parseDecision` each run once at execution.
 */
type Prechecked =
  | { ok: true; command: ApprovalCommand; parsed: unknown; decision: unknown }
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
    // The execution transaction is the owner of every write its command makes, permissions included:
    // a role or binding command's cache invalidation must wait for this commit, or a read in the
    // window caches pre-commit keys under the new cache generation.
    private readonly afterCommit: AfterCommitService,
  ) {}

  async execute(requestId: string, now: Date = new Date()): Promise<ApprovalRequestRecord> {
    const request = await this.requests.findById(requestId);
    if (!request) throw new ApprovalRequestNotFoundError(requestId);
    if (request.status !== 'approved') throw new ApprovalRequestNotPendingError(request.status);
    if (request.redeem === true) return request;

    // Every write below, the settle rows included, runs as the request's actor: the caller's own
    // context (the decider's, or none for a direct call) is not the one the command was asked under.
    const context = requestContext(request);
    return runWithActionContext(context, async () => {
      const checked = await this.precheck(request);
      if (checked.ok === false) return this.settle(request.id, { status: 'failed', settledAt: now, result: { error: checked.error } });

      // A redemption reports the command's own failure itself; an execution keeps settling it failed.
      const { settled } = await this.run(request, checked.command, checked.parsed, checked.decision, now);
      return settled;
    });
  }

  /**
   * US-004: the requester's redemption of an approved redeem request, in the call that re-sends the
   * full body. `execute` never runs such a request — an approval only released it — so this is the one
   * path that executes it, once, and answers the command's raw result (a one-time secret goes straight
   * back to the caller). The stored row keeps the `toResult` projection only.
   *
   * The checks are ordered cheapest-first and all run before anything executes: ownership, the pair and
   * the request's mode, the status, the window, the command's presence, its own `parse` (whose error is
   * the caller's answer), and the redacted body against the hash the gate wrote.
   */
  async redeem(requestId: string, call: RedeemCall, now: Date = new Date()): Promise<{ request: ApprovalRequestRecord; result: unknown }> {
    const request = await this.requests.findById(requestId);
    const actor = currentContext()?.actor;
    // Another principal's request, and an on-behalf-of one (the assistant's), read as missing: the
    // caller must not learn that an id it may not redeem exists.
    if (!request || actor === undefined || request.actor.type !== actor.type || request.actor.id !== actor.id ||
        request.onBehalfOf !== null) {
      throw new ApprovalRequestNotFoundError(requestId);
    }
    if (request.redeem !== true || request.permissionKey !== call.key ||
        (request.variant ?? null) !== (call.variant ?? null) || request.projectId !== call.projectId) {
      throw new ApprovalRedeemMismatchError(requestId);
    }
    if (request.status !== 'approved') throw new ApprovalRequestNotPendingError(request.status);
    if (request.expiresAt.getTime() <= now.getTime()) throw new ApprovalRequestExpiredError(requestId);

    const command = this.registry.get(request.permissionKey, request.variant);
    if (command?.redeem === undefined) throw new ApprovalRedeemMismatchError(requestId);

    const parsed = command.parse(call.input);
    // The same redaction the gate stored: a secret re-sent differently is not a different request.
    const stored = redeemStored(command, parsed);
    if (approvalInputHash(stored) !== request.inputHash) throw new ApprovalRedeemMismatchError(requestId);

    return runWithActionContext(requestContext(request), () => this.runRedeem(request, command, parsed, now));
  }

  /**
   * The redemption through the execution boundary an approved request already uses: the serialised
   * slot, the `approved` re-read under the row lock, `prepare`, `withExecution`, the settle and the
   * follow-up. A failed redemption answers the command's own error — the same answer an immediate call
   * gives — instead of the settled request `execute` answers.
   */
  private async runRedeem(
    request: ApprovalRequestRecord, command: ApprovalCommand, parsed: unknown, now: Date,
  ): Promise<{ request: ApprovalRequestRecord; result: unknown }> {
    const { settled, raw, failure } = await this.run(request, command, parsed, undefined, now);
    if (settled.status === 'executed') return { request: settled, result: raw?.result };
    if (failure !== undefined) throw failure.error;

    // The command never ran: the request was settled from under this call (the key was revoked, or a
    // queued redemption reached it first).
    throw new ApprovalRequestNotPendingError(settled.status);
  }

  private async precheck(request: ApprovalRequestRecord): Promise<Prechecked> {
    // The pair the request was opened for: a variant request whose command is gone has no command,
    // even while the key's primary command is still registered.
    const command = this.registry.get(request.permissionKey, request.variant);
    if (command === undefined) return { ok: false, error: 'no-command' };

    const hash = createHash('sha256').update(canonicalJson(request.input), 'utf8').digest('hex');
    if (hash !== request.inputHash) return { ok: false, error: 'input-hash-mismatch' };

    // A command that authorises itself when it runs (the REST decision) is not re-checked by key:
    // its run re-reads the decider's keys and refuses on its own, self-confirmation included.
    if (command.skipKeyRecheck !== true && !(await this.stillHoldsKey(request))) {
      return { ok: false, error: 'permission-revoked' };
    }

    let parsed: unknown;
    try {
      parsed = command.parse(request.input);
    } catch {
      return { ok: false, error: 'invalid-input' };
    }

    return this.withDecision(command, request.id, parsed);
  }

  /**
   * The decision step: the approving decision's params are re-parsed exactly as the frozen input is,
   * so what `execute` receives is what `parseDecision` produced at decide time. A command without the
   * hook takes no decision, so its decisions are never read.
   */
  private async withDecision(command: ApprovalCommand, requestId: string, parsed: unknown): Promise<Prechecked> {
    const parseDecision = command.parseDecision?.bind(command);
    if (parseDecision === undefined) return { ok: true, command, parsed, decision: undefined };

    // The last approval is the one that released the request; a timeout approval writes no decision
    // row at all, which is the only case with nothing to re-parse.
    const decisions = await this.requests.findDecisions(requestId);
    const approving = decisions.filter((decision) => decision.decision === 'approve').at(-1);

    try {
      return { ok: true, command, parsed, decision: parseDecision('approve', approving?.params ?? undefined, parsed) };
    } catch {
      return { ok: false, error: 'invalid-decision' };
    }
  }

  /**
   * The key-only re-check: the principal the action belongs to must still hold the key (or its
   * `.own` form) at the request's scope. Row ownership and domain rules are the command's business.
   * A system ask has no principal to re-check: the decider's eligibility at decide time is the
   * authority, and the command checks its own state when it runs.
   */
  private async stillHoldsKey(request: ApprovalRequestRecord): Promise<boolean> {
    const principal = recheckPrincipal(request);
    if (principal === 'skip') return true;
    if (principal === null) return false;

    const scope = request.projectId === null ? 'global' : { projectId: request.projectId };
    const keys = await this.permissions.effectiveKeys(principal, scope);
    return keys.has(request.permissionKey) || keys.has(`${request.permissionKey}${OWN_SUFFIX}`) ||
      (request.permissionKey === 'approval.decide' && holdsNarrowedDecide(keys));
  }

  /**
   * Steps 3 to 5. Only a failure of the callback is turned into a `failed` request: once the callback
   * has returned, a failing commit is reported to the caller and the request stays approved.
   *
   * The outcome also carries the command's raw result and the error it threw, which `execute` drops and
   * a redemption answers (US-004).
   */
  private async run(
    request: ApprovalRequestRecord, command: ApprovalCommand, parsed: unknown, decision: unknown, now: Date,
  ): Promise<RunOutcome> {
    // The row lock is released when the failed callback rolls back, before the failure settlement
    // opens its own transaction. Holding this request's slot across both keeps a waiting execute from
    // taking the still-approved row in that gap and running the command a second time.
    return this.serialised(request.id, async () => {
      // A queued caller may have read 'approved' before the preceding execution settled.
      // Refuse it before prepare: store work there cannot be rolled back by the later row lock.
      const current = await this.requests.findById(request.id);
      if (!current) throw new ApprovalRequestNotFoundError(request.id);
      if (current.status !== 'approved') throw new ApprovalRequestNotPendingError(current.status);
      const outcome = await this.executeOnce(request, command, parsed, decision, now);
      // Step 5: only a committed execution has a follow-up, and its failure changes nothing.
      if (outcome.settled.status === 'executed' && outcome.raw !== undefined) {
        await this.followUp(request.id, command, parsed, decision, outcome.raw.result);
      }

      return outcome;
    });
  }

  /**
   * The execution transaction. `raw` is the command's own result, kept for the follow-up hook because
   * the request stores the `toResult` projection instead. `failure` is the error the command's own work
   * threw, which a redemption reports to its caller and an execution swallows.
   */
  private async executeOnce(
    request: ApprovalRequestRecord, command: ApprovalCommand, parsed: unknown, decision: unknown, now: Date,
  ): Promise<RunOutcome> {
    // Set only when the callback itself threw: a transaction that fails to open, or to commit after
    // the callback succeeded, is reported to the caller and never settles the request.
    let callbackFailure: { error: unknown } | undefined;
    let raw: { result: unknown } | undefined;
    let prepared: (() => Promise<unknown>) | undefined;
    try {
      prepared = await command.prepare?.(parsed, decision);
    } catch (error) {
      return {
        settled: await this.settle(request.id, {
          status: 'failed', settledAt: now, result: { error: 'execution-failed', name: errorName(error) },
        }),
        failure: { error },
      };
    }
    try {
      // This transaction owns every write the command makes, so it also owns their after-commit
      // work: a role or binding command's permission-cache invalidation is deferred here and runs
      // once the commit ended. Flushed before it, a concurrent read would recompute the pre-commit
      // keys and cache them under the new generation, keeping revoked access for one TTL.
      const transaction = () => this.afterCommit.scope(() => withCommittedEffects(() => this.txManager.run(async () => {
        try {
          const locked = await this.requests.lockById(request.id);
          if (!locked) throw new ApprovalRequestNotFoundError(request.id);
          if (locked.status !== 'approved') throw new ApprovalRequestNotPendingError(locked.status);

          // Preparation can be slow: authority must still hold when we take the request lock.
          if (prepared && command.skipKeyRecheck !== true && !(await this.stillHoldsKey(locked))) {
            const revoked = await bookkeeping('approval.request-settle', async () => {
              const row = await this.requests.transition(request.id, 'approved', {
                status: 'failed', settledAt: now, result: { error: 'permission-revoked' },
              });
              if (row) await this.events.record(row);
              return row;
            });
            if (!revoked) throw new ApprovalRequestNotPendingError(locked.status);
            return revoked;
          }
          // The request's immutable project scope is the authority. Hold that project row
          // until commit so a slug lookup cannot drift to a different project during execution.
          if (locked.variant?.startsWith('rest:') && locked.projectId !== null &&
              typeof parsed === 'object' && parsed !== null && 'slug' in parsed && typeof parsed.slug === 'string') {
            await this.requests.lockProjectSlug(locked.projectId, parsed.slug);
          }
          const result = await (prepared ? prepared() : command.execute(parsed, decision));
          raw = { result };
          const settled = await bookkeeping('approval.request-settle', async () => {
            const transitioned = await this.requests.transition(request.id, 'approved', {
              status: 'executed', settledAt: now, result: command.toResult?.(result) ?? null,
            });
            if (transitioned) await this.events.record(transitioned);
            return transitioned;
          });
          // The row is locked by this transaction, so a lost transition means a broken boundary: roll back.
          if (!settled) throw new ApprovalRequestNotPendingError(locked.status);

          return settled;
        } catch (error) {
          callbackFailure = { error };
          throw error;
        }
      })));

      const settled = await (command.withExecution ? command.withExecution(parsed, transaction) : transaction());
      return { settled, raw };
    } catch (error) {
      if (callbackFailure === undefined || error instanceof ApprovalRequestNotPendingError) throw error;

      this.logger.warn(`approval request ${request.id} failed to execute: ${errorMessage(error)}`);
      return {
        settled: await this.settle(request.id, {
          status: 'failed', settledAt: now, result: { error: 'execution-failed', name: errorName(error) },
        }),
        failure: { error },
      };
    }
  }

  /**
   * The command's own follow-up, run once its transaction committed and still under the request's
   * context. It is warning-only: the command's writes are already durable, so a throw leaves the
   * request executed. Only the transaction owner reaches this after a real commit — inside a caller's
   * own `withCommittedEffects` scope (the assistant executor), it runs when that owner's callback returns.
   */
  private async followUp(requestId: string, command: ApprovalCommand, parsed: unknown, decision: unknown, result: unknown): Promise<void> {
    const afterCommit = command.afterCommit?.bind(command);
    if (afterCommit === undefined) return;

    try {
      await afterCommit(parsed, decision, result);
    } catch (error) {
      this.logger.warn(`approval request ${requestId} after-commit failed: ${errorMessage(error)}`);
    }
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

/**
 * The principal whose authority is re-checked: the on-behalf-of one for the assistant, `'skip'` for
 * any other system component (an ask was not chosen by a principal), else the actor. `null` means
 * there is no principal to check, which fails the re-check.
 */
function recheckPrincipal(request: ApprovalRequestRecord): RecheckPrincipal {
  const { actor, onBehalfOf } = request;
  if (actor.type === 'SYSTEM') return actor.id === 'assistant' ? onBehalfOf : 'skip';
  if (actor.type === 'USER' || actor.type === 'AGENT') return { type: actor.type, id: actor.id };
  return null;
}

/**
 * The approval a request carries into its execution context: what mode released it, who satisfied it,
 * the approver and the request id.
 */
export function approvalOf(request: ApprovalRequestRecord): ActionApproval {
  return {
    requiredMode: request.requiredMode,
    satisfiedBy: request.satisfiedBy ?? 'none',
    ...(request.approverType !== null && request.approverId !== null
      ? { approverType: request.approverType, approverId: request.approverId } : {}),
    requestId: request.id,
  };
}

/** The context the request was opened in, now carrying the approval that released it. */
function requestContext(request: ApprovalRequestRecord): ActionContextInput {
  return {
    actor: request.actor, origin: request.origin, correlationId: request.correlationId, approval: approvalOf(request),
    ...(request.onBehalfOf !== null ? { onBehalfOf: request.onBehalfOf } : {}),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
