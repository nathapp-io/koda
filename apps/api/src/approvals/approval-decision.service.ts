import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { withCommittedEffects } from '../common/committed-effects';
import { currentContext, runWithActionContext, type ActionApproval } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PermissionService } from '../permissions/permission.service';
import { decideEligibility } from './approval-eligibility';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalCancelForbiddenError, ApprovalDecideForbiddenError, ApprovalDecisionParamsInvalidError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from './domain/approval.errors';
import { ApprovalExecutionService } from './approval-execution.service';
import { ApprovalCommandRegistry, type ApprovalCommand } from './approval-command.registry';
import { canonicalJson } from './canonical-json';
import { freezeApprovalInput } from './approval-input';
import { ApprovalRequestEvents } from './approval-request-events';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

@Injectable()
export class ApprovalDecisionService {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly requests: PrismaApprovalRequestRepository,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
    private readonly execution: ApprovalExecutionService,
    private readonly events: ApprovalRequestEvents,
    private readonly registry: ApprovalCommandRegistry,
  ) {}

  /**
   * @param params The decider's choice, when the action asks for one. `null` means absent, so a
   *   client answering "no params" and one omitting the field decide the same way.
   */
  async decide(requestId: string, decision: 'approve' | 'reject', comment: string | null, now = new Date(), params?: unknown): Promise<ApprovalRequestRecord> {
    const decided = await this.record(requestId, decision, comment, now, params ?? undefined);
    // The decision is committed before the command runs, in its own transaction, so a failing
    // command leaves the approval on record and settles the request as failed.
    return decision === 'approve' ? this.execution.execute(requestId) : decided;
  }

  async cancel(requestId: string, now = new Date()): Promise<ApprovalRequestRecord> {
    return this.txManager.run(async () => {
      const request = await this.requests.lockById(requestId);
      if (!request) throw new ApprovalRequestNotFoundError(requestId);
      if (request.status !== 'pending') throw new ApprovalRequestNotPendingError(request.status);

      const actor = currentContext()?.actor;
      const requester = request.actor.type === 'SYSTEM' && request.actor.id === 'assistant'
        ? request.onBehalfOf : request.actor;
      if (!actor || (actor.type !== 'USER' && actor.type !== 'AGENT') ||
          actor.type !== requester?.type || actor.id !== requester.id) {
        throw new ApprovalCancelForbiddenError(requestId);
      }
      const cancelled = await this.requests.transition(requestId, 'pending', { status: 'cancelled', settledAt: now });
      // A lost CAS under the row lock must roll back, never emit phantom bookkeeping.
      if (!cancelled) throw new ApprovalRequestNotPendingError(request.status);
      await this.events.record(cancelled);
      await this.audit.record({
        key: 'approval.request.cancel', resourceType: 'approval-request', resourceId: requestId,
        projectId: request.projectId, summary: `cancelled ${request.permissionKey}`,
      });
      return cancelled;
    });
  }

  private record(requestId: string, decision: 'approve' | 'reject', comment: string | null, now: Date, params: unknown): Promise<ApprovalRequestRecord> {
    // The decide transaction's OWNER. A rejection's command hook may queue a committed effect (the
    // fleet's runner wake, a live publication); wrapping the complete `run()`, not its callback, is
    // what holds those effects until the decision and the rows the hook wrote have really committed,
    // and drops them when the callback rolls back or the commit fails.
    return withCommittedEffects(() => this.txManager.run(async () => {
      const request = await this.requests.lockById(requestId);
      if (!request) throw new ApprovalRequestNotFoundError(requestId);
      if (request.status !== 'pending') throw new ApprovalRequestNotPendingError(request.status);
      if (request.expiresAt.getTime() <= now.getTime()) throw new ApprovalRequestExpiredError(requestId);

      const context = currentContext();
      if (!context) throw new Error('approval decision needs an action context');
      const decider = context.actor;
      const keys = decider.type === 'USER' || decider.type === 'AGENT'
        ? await this.permissions.effectiveKeys({ type: decider.type, id: decider.id }, request.projectId ? { projectId: request.projectId } : 'global')
        : new Set<string>();
      const eligibility = decideEligibility(request, decider, keys);
      if (eligibility.ok === false) throw new ApprovalDecideForbiddenError(eligibility.reason);
      // Keep the persistence boundary principal-only even if eligibility is replaced by a test seam.
      if (decider.type !== 'USER' && decider.type !== 'AGENT') throw new ApprovalDecideForbiddenError('not-a-principal');

      const command = this.registry.get(request.permissionKey);
      const { parsedInput, parsed } = parseDecisionParams(command, decision, params, request.input);

      await this.requests.createDecision({
        requestId, deciderType: decider.type, deciderId: decider.id, decision, comment, decidedAt: now,
        params: parsed === undefined ? null : freezeApprovalInput(parsed),
      });
      const approved = decision === 'approve';
      const attribution = approved ? { satisfiedBy: eligibility.satisfiedBy, approverType: decider.type, approverId: decider.id } : {};
      const updated = await this.requests.transition(requestId, 'pending', {
        status: approved ? 'approved' : 'rejected', decidedAt: now, ...attribution,
      });
      // A lost CAS under our row lock indicates a broken transaction boundary: roll back all writes.
      if (!updated) throw new ApprovalRequestNotPendingError(request.status);
      await this.events.record(updated);
      const approval: ActionApproval = {
        requiredMode: request.requiredMode, satisfiedBy: approved ? eligibility.satisfiedBy : 'none',
        ...(approved ? { approverType: decider.type, approverId: decider.id } : {}), requestId,
      };
      await runWithActionContext({ ...context, approval }, async () => {
        await this.audit.record({
          key: 'approval.decide', resourceType: 'approval-request', resourceId: requestId,
          projectId: request.projectId, summary: `${approved ? 'approved' : 'rejected'} ${request.permissionKey}`,
        });
        // A rejection's effect runs inside this transaction, under the approval just recorded: a throw
        // rolls the decision back, leaving the request pending for a decider who can act on it.
        if (decision === 'reject' && command?.onReject !== undefined) await command.onReject(parsedInput, parsed);
      });
      return updated;
    }));
  }
}

/** The cap on a decision's params: the length of their canonical JSON, in characters. */
const DECISION_PARAMS_MAX_JSON = 4_096;

/**
 * The decide-time params contract, in order: the frozen input is re-parsed once when a hook needs it,
 * params are refused on a command that takes none, refused over the size cap, then validated by
 * `parseDecision`. The size check runs before `parseDecision`, so an oversized value is never parsed;
 * the input re-parse runs first of all, because the input was frozen from `parse`'s own output and a
 * parse that now throws means the command changed incompatibly.
 */
function parseDecisionParams(
  command: ApprovalCommand | undefined, decision: 'approve' | 'reject', params: unknown, input: unknown,
): { parsedInput: unknown; parsed: unknown } {
  const parsedInput = parseFrozenInput(command, input);
  if (command?.parseDecision === undefined) {
    if (params !== undefined) throw new ApprovalDecisionParamsInvalidError('not-accepted');
    return { parsedInput, parsed: undefined };
  }
  if (params !== undefined && canonicalJson(params).length > DECISION_PARAMS_MAX_JSON) {
    throw new ApprovalDecisionParamsInvalidError('too-large');
  }

  try {
    return { parsedInput, parsed: command.parseDecision(decision, params, parsedInput) };
  } catch {
    throw new ApprovalDecisionParamsInvalidError('invalid');
  }
}

/** Step 1: the frozen input, re-parsed once for a command that has a decision hook; else untouched. */
function parseFrozenInput(command: ApprovalCommand | undefined, input: unknown): unknown {
  if (command === undefined || (command.parseDecision === undefined && command.onReject === undefined)) return undefined;

  try {
    return command.parse(input);
  } catch {
    throw new ApprovalDecisionParamsInvalidError('invalid');
  }
}
