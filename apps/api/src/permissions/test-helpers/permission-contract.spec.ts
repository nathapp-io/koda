import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, PENDING_SURFACE_KEYS } from '../catalog';
import { PENDING_GATE_ROUTES, SECRET_GATE_ROUTES, type PendingGateFeature } from '../pending-gate-routes';
import type { RequiresMetadata } from '../requires.decorator';
import {
  findContractViolations as findContractViolationsWithAllowlist,
  type ContractViolation,
  type PermissionDeclarations,
} from './permission-contract';

describe('permission contract checker', () => {
  const findContractViolations = (
    declarations: PermissionDeclarations,
    catalog = PERMISSION_CATALOG,
    pending: ReadonlySet<string> = PENDING_SURFACE_KEYS,
    pendingGateRoutes: ReadonlyMap<string, PendingGateFeature> = new Map(),
  ) => findContractViolationsWithAllowlist(declarations, catalog, pending, pendingGateRoutes);

  const expectedPending = new Set([
    'fleet.approval.decide.assistant',
    // Permissions P1 US-003 deleted the two member routes that declared this key. Removing a
    // principal from a project is now deleting its bindings, which `role.binding.manage` gates, and
    // the key waits for P3 policy to decide whether it gates binding removal.
    'member.remove',
    'fleet.job.shell.escalate',
    'fleet.budget.override',
  ]);
  const requires = (keys: readonly string[], enforcedBy: 'guard' | 'service' = 'guard'): RequiresMetadata => ({
    keys,
    mode: 'all',
    enforcedBy,
  });
  const declarations = (overrides: Partial<PermissionDeclarations> = {}): PermissionDeclarations => ({
    routes: [],
    tools: [],
    systemWriters: [],
    ...overrides,
  });
  const route = (
    keys: readonly string[] | undefined,
    enforcedBy: 'guard' | 'service' = 'guard',
    hasRequiresGuard = true,
    method = 'GET',
    gated = false,
    label = `${method} /x`,
  ) => ({
    route: label,
    method,
    gated,
    requires: keys === undefined ? undefined : requires(keys, enforcedBy),
    hasRequiresGuard,
  });
  const entry = (key: string, approvable: boolean, defaultMode: 'none' | 'human' = 'none') => ({
    key,
    scope: 'global' as const,
    access: 'role' as const,
    risk: 'low' as const,
    principals: ['agent'] as const,
    ownable: false,
    approval: { approvable, floor: 'none' as const, default: defaultMode },
  });
  const isolated = (routes: PermissionDeclarations['routes'], catalog = [entry('label.delete', true)]) =>
    findContractViolations(declarations({ routes }), catalog, new Set(), new Map());
  const asSet = (violations: readonly ContractViolation[]) =>
    new Set(violations.map((violation) => JSON.stringify(violation)));
  const contains = (violations: readonly ContractViolation[], expected: ContractViolation) =>
    expect(asSet(violations)).toContain(JSON.stringify(expected));

  it('AC-1: reports an ungated approvable write', () => {
    contains(isolated([route(['label.delete'], 'service', false, 'DELETE', false, 'DELETE /labels/:id')]), {
      kind: 'ungated-approvable-write', route: 'DELETE /labels/:id',
    });
  });

  it('AC-2: a pending gate route exempts an ungated approvable write', () => {
    expect(findContractViolations(
      declarations({ routes: [route(['label.delete'], 'service', false, 'DELETE', false, 'DELETE /labels/:id')] }),
      [entry('label.delete', true)], new Set(), new Map([['DELETE /labels/:id', 'gate-core-domains']]),
    )).toEqual([]);
  });

  it('AC-3: reports a gated route without an approvable key', () => {
    const violations = isolated([route(['ticket.read'], 'service', false, 'POST', true)], [entry('ticket.read', false)]);
    contains(violations, { kind: 'gated-without-approvable-key', route: 'POST /x' });
  });

  it('AC-4: reports a pending gate route that is gated', () => {
    const violations = findContractViolations(
      declarations({ routes: [route(['label.delete'], 'service', false, 'DELETE', true, 'DELETE /labels/:id')] }),
      [entry('label.delete', true)], new Set(), new Map([['DELETE /labels/:id', 'gate-core-domains']]),
    );
    contains(violations, { kind: 'stale-pending-gate-route', route: 'DELETE /labels/:id' });
  });

  it('AC-5: reports a pending gate route absent from declarations', () => {
    const violations = findContractViolations(declarations(), [], new Set(), new Map([['POST /gone', 'gate-secret']]));
    contains(violations, { kind: 'stale-pending-gate-route', route: 'POST /gone' });
  });

  it('AC-6: does not gate read routes', () => {
    expect(isolated([route(['approval.decide'], 'service', false, 'GET')], [entry('approval.decide', true)])).toEqual([]);
  });

  it('AC-7: uses the supplied catalog approvability', () => {
    expect(isolated([route(['label.delete'], 'service', false, 'DELETE')], [entry('label.delete', false)])).toEqual([]);
  });

  it('AC-9: rollout gate map excludes all routes already gated in this feature', () => {
    const excluded = [
      'POST /roles', 'PATCH /roles', 'DELETE /roles', 'POST /role-bindings', 'DELETE /role-bindings',
      'POST /approval-policies', 'PATCH /approval-policies', 'DELETE /approval-policies',
      'POST /projects/:slug/approval-policies', 'PATCH /projects/:slug/approval-policies',
      'DELETE /projects/:slug/approval-policies', 'POST /approvals/:id/decisions',
    ];
    for (const routePrefix of excluded) {
      expect([...PENDING_GATE_ROUTES.keys()].some((route) => route.startsWith(routePrefix))).toBe(false);
    }
  });

  it('AC-6: explicitly lists exactly the secret-bearing routes', () => {
    expect(SECRET_GATE_ROUTES).toEqual(new Set([
      'POST /fleet/enrollments',
      'POST /projects/:slug/vcs',
      'PATCH /projects/:slug/vcs',
      'POST /projects/:slug/vcs/webhook-secret/rotate',
      'POST /projects/:slug/webhooks',
      'PATCH /projects/:slug/webhooks/:id',
      'POST /projects/:slug/invites',
      'POST /projects/:slug/invites/:id/resend',
    ]));
  });

  it('AC-7: assigns every explicit secret route to gate-secret', () => {
    for (const route of SECRET_GATE_ROUTES) expect(PENDING_GATE_ROUTES.get(route)).toBe('gate-secret');
  });

  it('AC-1 (US-010): has no gate-high pending assignments', () => {
    expect([...PENDING_GATE_ROUTES.values()]).not.toContain('gate-high');
  });

  it('AC-10: has no pending entry for gated project deletion', () => {
    expect(PENDING_GATE_ROUTES.get('DELETE /projects/:slug')).toBeUndefined();
  });

  it('AC-11: assigns memory creation to gate-core-domains', () => {
    expect(PENDING_GATE_ROUTES.get('POST /memory')).toBe('gate-core-domains');
  });

  it('US-001 AC-2: assigns invite resend to gate-secret', () => {
    expect(PENDING_GATE_ROUTES.get('POST /projects/:slug/invites/:id/resend')).toBe('gate-secret');
  });

  it('US-001 AC-3: leaves invite cancellation in gate-core-domains', () => {
    expect(PENDING_GATE_ROUTES.get('DELETE /projects/:slug/invites/:id')).toBe('gate-core-domains');
  });

  it('AC-12: assigns project thread creation to gate-fleet', () => {
    expect(PENDING_GATE_ROUTES.get('POST /projects/:slug/threads')).toBe('gate-fleet');
  });

  it('AC-8: approval.decide is no longer pending', () => {
    expect(PENDING_SURFACE_KEYS.has('approval.decide')).toBe(false);
  });

  it('AC-14: audit.read is no longer pending', () => {
    expect(PENDING_SURFACE_KEYS.has('audit.read')).toBe(false);
  });

  it('defines exactly the pending surface keys and each exists in the catalog', () => {
    expect(PENDING_SURFACE_KEYS).toEqual(expectedPending);
    const catalogKeys = new Set(PERMISSION_CATALOG.map(({ key }) => key));
    for (const key of PENDING_SURFACE_KEYS) expect(catalogKeys.has(key)).toBe(true);
  });

  it('reports a route without Requires metadata', () => {
    contains(findContractViolations(declarations({ routes: [route(undefined)] })), {
      kind: 'route-without-key', route: 'GET /x',
    });
  });

  it('reports unknown keys declared by routes, tools and system writers', () => {
    const routeViolations = findContractViolations(declarations({ routes: [route(['no.such.key'])] }));
    contains(routeViolations, { kind: 'unknown-key', source: 'GET /x', key: 'no.such.key' });
    const toolViolations = findContractViolations(declarations({ tools: [{ tool: 'koda_x', key: 'no.such.key' }] }));
    contains(toolViolations, { kind: 'unknown-key', source: 'koda_x', key: 'no.such.key' });
    const writerViolations = findContractViolations(declarations({ systemWriters: [{ writer: 'XSweeper', key: 'no.such.key' }] }));
    contains(writerViolations, { kind: 'unknown-key', source: 'XSweeper', key: 'no.such.key' });
  });

  it('requires a guard only when a route is guard-enforced', () => {
    const catalog = [{ key: 'k.one' }] as const;
    const guarded = findContractViolations(declarations({ routes: [route(['k.one'], 'guard', false)] }), catalog, new Set());
    contains(guarded, { kind: 'guard-missing', route: 'GET /x' });
    const serviced = findContractViolations(declarations({ routes: [route(['k.one'], 'service', false)] }), catalog, new Set());
    expect(serviced.some(({ kind }) => kind === 'guard-missing')).toBe(false);
  });

  it('reports exactly the catalog key not declared by a route', () => {
    const violations = findContractViolations(declarations({ routes: [route(['k.one'])] }), [
      { key: 'k.one' }, { key: 'k.two' },
    ], new Set());
    expect(asSet(violations)).toEqual(new Set([JSON.stringify({ kind: 'unused-key', key: 'k.two' })]));
  });

  it('still checks unused catalog keys when a route lacks Requires metadata', () => {
    const violations = findContractViolations(declarations({ routes: [route(undefined)] }), [
      { key: 'k.one' }, { key: 'k.two' },
    ], new Set());
    contains(violations, { kind: 'unused-key', key: 'k.one' });
    contains(violations, { kind: 'unused-key', key: 'k.two' });
  });

  it('exempts pending keys until declared, then reports the pending declaration', () => {
    const catalog = [{ key: 'k.one' }, { key: 'k.two' }] as const;
    const pending = new Set(['k.two']);
    expect(findContractViolations(declarations({ routes: [route(['k.one'])] }), catalog, pending)).toEqual([]);
    const violations = findContractViolations(declarations({ routes: [route(['k.one', 'k.two'])] }), catalog, pending);
    contains(violations, { kind: 'pending-key-declared', source: 'GET /x', key: 'k.two' });
  });

  it('counts tools and system writers as declarations', () => {
    expect(findContractViolations(declarations({
      tools: [{ tool: 'koda_x', key: 'k.one' }],
      systemWriters: [{ writer: 'XSweeper', key: 'k.two' }],
    }), [{ key: 'k.one' }, { key: 'k.two' }], new Set())).toEqual([]);
  });
});
