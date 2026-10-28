/**
 * US-003 AC-7..AC-11 and AC-13 — `ApprovalRouteGate.run` gates a REST entry point: it refuses a
 * non-principal actor, refuses a caller that does not hold the key (so no request is opened for a
 * write that would fail at execution), then hands the call to the engine's gate.
 */
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import {
  runAsSystem,
  runWithActionContext,
  type ActionActor,
} from '../../action-context/action-context';
import { NO_APPROVAL } from '../../action-context/action-context';
import type { ApprovalGate, GateOutcome } from '../approval-gate.service';
import type { ApprovalRequestRecord } from '../domain/approval.domain';
import type { PermissionService } from '../../permissions/permission.service';
import { ApprovalRouteGate, type RouteGateCall } from './approval-route-gate';

const record: ApprovalRequestRecord = {
  id: 'request', permissionKey: 'role.manage', projectId: null, actor: { type: 'AGENT', id: 'agent' },
  onBehalfOf: null, origin: 'rest', correlationId: 'correlation', input: { key: 'qa' }, inputHash: 'hash',
  requiredMode: 'human', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
  requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
  expiresAt: new Date('2026-10-02T00:00:00.000Z'), decidedAt: null, settledAt: null, result: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
};

interface Harness {
  gate: { gate: ReturnType<typeof vi.fn> };
  permissions: { effectiveKeys: ReturnType<typeof vi.fn>; canHoldKey: ReturnType<typeof vi.fn> };
  routeGate: ApprovalRouteGate;
}

/** The gate and permission service as the route gate sees them, holding `keys` at every scope. */
function harness(keys: string[] = [], outcome?: GateOutcome<unknown>): Harness {
  const gate = { gate: vi.fn().mockResolvedValue(outcome ?? { status: 'pending', request: record }) };
  const effectiveKeys = vi.fn().mockResolvedValue(new Set(keys));
  const canHoldKey = vi.fn(async (
    principal: { type: 'USER' | 'AGENT' },
    key: string,
    scope: unknown,
    requirePossession = true,
  ) => {
    if (key === 'role.binding.owner' && principal.type !== 'USER') return false;
    if (!requirePossession) return true;
    const held = await effectiveKeys(principal, scope);
    return held.has(key) || held.has(`${key}.own`);
  });
  const permissions = { effectiveKeys, canHoldKey };

  return {
    gate,
    permissions,
    routeGate: new ApprovalRouteGate(
      gate as unknown as ApprovalGate,
      permissions as unknown as PermissionService,
    ),
  };
}

/** Runs `call` under `actor`'s action context. */
function asActor<T>(actor: ActionActor, call: () => Promise<T>): Promise<T> {
  const origin = actor.type === 'RUNNER' ? 'runner' : 'rest';

  return runWithActionContext({ actor, origin }, call);
}

const agent: ActionActor = { type: 'AGENT', id: 'agent' };
const input: Record<string, unknown> = { key: 'qa' };

function call(patch: Partial<RouteGateCall> = {}): RouteGateCall {
  return { key: 'role.manage', variant: 'rest:roles.create', projectId: null, input, ...patch };
}

describe('ApprovalRouteGate', () => {
  it('AC-7: an agent without the key is refused and opens no request', async () => {
    const h = harness(['role.read']);

    const error = await asActor(agent, () => h.routeGate.run(call())).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect((error as ForbiddenAppException).prefix).toBe('permissions');
    expect((error as ForbiddenAppException).httpStatus).toBe(403);
    expect(h.gate.gate).not.toHaveBeenCalled();
  });

  it('AC-8: a key held only in its .own form passes the check and reaches the gate', async () => {
    const h = harness(['ticket.update.own']);

    await asActor(agent, () =>
      h.routeGate.run(call({ key: 'ticket.update', variant: 'rest:tickets.update', projectId: 'p1' })),
    );

    expect(h.gate.gate).toHaveBeenCalledWith('ticket.update', input, { projectId: 'p1', variant: 'rest:tickets.update' });
  });

  it('AC-9: reads the effective keys at global for a global call and at the project otherwise', async () => {
    const h = harness(['role.manage']);

    await asActor(agent, () => h.routeGate.run(call()));
    expect(h.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'AGENT', id: 'agent' }, 'global');

    await asActor(agent, () => h.routeGate.run(call({ projectId: 'p1' })));
    expect(h.permissions.effectiveKeys).toHaveBeenLastCalledWith({ type: 'AGENT', id: 'agent' }, { projectId: 'p1' });
  });

  it('refuses an agent-only key by catalog principal type even when keyCheck is disabled', async () => {
    const h = harness(['role.binding.owner']);

    const error = await asActor(agent, () => h.routeGate.run(call({ key: 'role.binding.owner', keyCheck: false })))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect((error as ForbiddenAppException).prefix).toBe('permissions');
    expect(h.permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(h.gate.gate).not.toHaveBeenCalled();
  });

  it('AC-10: keyCheck false reaches the gate without reading any key', async () => {
    const h = harness([]);

    await asActor(agent, () => h.routeGate.run(call({ keyCheck: false })));

    expect(h.permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(h.gate.gate).toHaveBeenCalledWith('role.manage', input, { projectId: null, variant: 'rest:roles.create' });
  });

  it('AC-11: a SYSTEM actor needs a principal actor and opens no request', async () => {
    const h = harness(['role.manage']);

    const error = await runAsSystem('budget', () => h.routeGate.run(call())).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('approval route gate needs a principal actor');
    expect(h.gate.gate).not.toHaveBeenCalled();
  });

  it('AC-13: a RUNNER actor is refused with permissions and opens no request', async () => {
    const h = harness(['role.manage']);

    const error = await asActor({ type: 'RUNNER', id: 'r1' }, () => h.routeGate.run(call()))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect((error as ForbiddenAppException).prefix).toBe('permissions');
    expect(h.gate.gate).not.toHaveBeenCalled();
  });

  it('needs a principal actor when there is no action context at all', async () => {
    const h = harness(['role.manage']);

    await expect(h.routeGate.run(call())).rejects.toThrow('approval route gate needs a principal actor');
    expect(h.gate.gate).not.toHaveBeenCalled();
  });

  it('answers the gate outcome unchanged', async () => {
    const executed: GateOutcome<string> = { status: 'executed', result: 'created', approval: NO_APPROVAL };
    const h = harness(['role.manage'], executed);

    await expect(asActor(agent, () => h.routeGate.run<string>(call()))).resolves.toBe(executed);
  });

  it('passes a user actor through the same check', async () => {
    const h = harness([]);

    const error = await asActor({ type: 'USER', id: 'u1' }, () => h.routeGate.run(call()))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(h.permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, 'global');
  });
});
