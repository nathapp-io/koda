import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { currentContext } from '../../action-context/action-context';
import { PermissionService, type PermissionScope } from '../../permissions/permission.service';
import { ApprovalGate, type GateOutcome } from '../approval-gate.service';
import { approvalOf, ApprovalExecutionService } from '../approval-execution.service';
import { rethrowApprovalError } from '../approval-http-errors';

/** What a gated handler asks the route gate to run. */
export interface RouteGateCall {
  /** The approvable catalog key the write needs. */
  key: string;
  /** The command variant this route registered for the key. */
  variant?: string;
  /** The request's project, or null for a global write. */
  projectId: string | null;
  input: unknown;
  /**
   * The request the caller redeems (the `X-Koda-Approval-Request` header), for a redeem route only.
   * Absent or empty is an ordinary call; an unknown value reads as a missing request (404).
   */
  redeem?: string;
  /**
   * Whether to check that the caller holds `key` (or `key.own`) before opening a request. Defaults to
   * true; a route that already proved the key in its guard (or service) may skip the second read.
   */
  keyCheck?: boolean;
}

/**
 * US-003: the REST entry point of the approval gate.
 *
 * A gated handler does not call `ApprovalGate` directly, because two of its steps belong to a route:
 *
 * 1. the actor must be a principal. A runner key reaching a service-enforced route is refused the way
 *    every runner refusal reads (403 `permissions`); a system component has no REST route at all, so
 *    its reaching here is a wiring error, not a request to answer.
 * 2. the caller must hold the key. Without this a service-enforced route — where no guard answers 403
 *    first — would let an agent that holds nothing fill the approvals inbox with requests whose
 *    execution is certain to fail. Checking here opens no request for a write that cannot run.
 *
 * Then the engine's gate decides, exactly as it does for an MCP or assistant write — unless the call
 * redeems an approved redeem request (US-004), which the execution service runs instead.
 */
@Injectable()
export class ApprovalRouteGate {
  constructor(
    private readonly gate: ApprovalGate,
    private readonly permissions: PermissionService,
    private readonly execution: ApprovalExecutionService,
  ) {}

  async run<TResult>(call: RouteGateCall): Promise<GateOutcome<TResult>> {
    const { key, variant, projectId, input, keyCheck = true, redeem } = call;
    const actor = currentContext()?.actor;
    if (actor === undefined) throw new Error('approval route gate needs a principal actor');
    if (actor.type === 'RUNNER') throw new ForbiddenAppException({}, 'permissions');
    if (actor.type !== 'USER' && actor.type !== 'AGENT') {
      throw new Error('approval route gate needs a principal actor');
    }
    if (!(await this.permissions.canHoldKey(
      { type: actor.type, id: actor.id },
      key,
      scopeOf(projectId),
      keyCheck,
    ))) {
      throw new ForbiddenAppException({}, 'permissions');
    }

    // US-004: a non-empty header redeems the approved request instead of asking the engine. The key
    // check above is the redemption's authority — the requester is the request's actor, and it was
    // re-checked in the same call — so the redemption itself re-checks no key.
    if (redeem !== undefined && redeem !== '') {
      try {
        const { request, result } = await this.execution.redeem(redeem, { key, variant, projectId, input });
        return { status: 'executed', result: result as TResult, approval: approvalOf(request) };
      } catch (error) {
        rethrowApprovalError(error);
      }
    }

    return this.gate.gate<TResult>(key, input, { projectId, variant });
  }

}

/** A global write reads the principal's global keys; a project write, that project's keys. */
function scopeOf(projectId: string | null): PermissionScope {
  return projectId === null ? 'global' : { projectId };
}
