import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { currentContext } from '../../action-context/action-context';
import { PermissionService, type PermissionScope } from '../../permissions/permission.service';
import { ApprovalGate, type GateOutcome } from '../approval-gate.service';

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
   * Whether to check that the caller holds `key` (or `key.own`) before opening a request. Defaults to
   * true; a route that already proved the key in its guard (or service) may skip the second read.
   */
  keyCheck?: boolean;
}

/** The suffix a role entry uses for "on rows the caller created". */
const OWN_SUFFIX = '.own';

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
 * Then the engine's gate decides, exactly as it does for an MCP or assistant write.
 */
@Injectable()
export class ApprovalRouteGate {
  constructor(
    private readonly gate: ApprovalGate,
    private readonly permissions: PermissionService,
  ) {}

  async run<TResult>(call: RouteGateCall): Promise<GateOutcome<TResult>> {
    const { key, variant, projectId, input, keyCheck = true } = call;
    const actor = currentContext()?.actor;
    if (actor === undefined) throw new Error('approval route gate needs a principal actor');
    if (actor.type === 'RUNNER') throw new ForbiddenAppException({}, 'permissions');
    if (actor.type !== 'USER' && actor.type !== 'AGENT') {
      throw new Error('approval route gate needs a principal actor');
    }

    if (keyCheck && !(await this.holdsKey(actor.type, actor.id, key, scopeOf(projectId)))) {
      throw new ForbiddenAppException({}, 'permissions');
    }

    return this.gate.gate<TResult>(key, input, { projectId, variant });
  }

  /** The union of `key` and `key.own` in the request's scope, as `PermissionService.can` reads it. */
  private async holdsKey(
    type: 'USER' | 'AGENT',
    id: string,
    key: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    const held = await this.permissions.effectiveKeys({ type, id }, scope);
    return held.has(key) || held.has(`${key}${OWN_SUFFIX}`);
  }
}

/** A global write reads the principal's global keys; a project write, that project's keys. */
function scopeOf(projectId: string | null): PermissionScope {
  return projectId === null ? 'global' : { projectId };
}
