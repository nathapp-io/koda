import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, PENDING_SURFACE_KEYS } from '../catalog';
import type { RequiresMetadata } from '../requires.decorator';
import { findContractViolations, type ContractViolation, type PermissionDeclarations } from './permission-contract';

describe('permission contract checker', () => {
  const expectedPending = new Set([
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
    routes: [], tools: [], systemWriters: [], ...overrides,
  });
  const route = (
    keys: readonly string[] | undefined,
    enforcedBy: 'guard' | 'service' = 'guard',
    hasRequiresGuard = true,
    method = 'GET',
    gated = false,
    label = `${method} /x`,
  ) => ({ route: label, method, gated, requires: keys === undefined ? undefined : requires(keys, enforcedBy), hasRequiresGuard });
  const entry = (key: string, approvable: boolean, defaultMode: 'none' | 'human' = 'none') => ({
    key, scope: 'global' as const, access: 'role' as const, risk: 'low' as const,
    principals: ['agent'] as const, ownable: false,
    approval: { approvable, floor: 'none' as const, default: defaultMode },
  });
  const isolated = (routes: PermissionDeclarations['routes'], catalog = [entry('label.delete', true)]) =>
    findContractViolations(declarations({ routes }), catalog, new Set());
  const asSet = (violations: readonly ContractViolation[]) => new Set(violations.map((violation) => JSON.stringify(violation)));
  const contains = (violations: readonly ContractViolation[], expected: ContractViolation) =>
    expect(asSet(violations)).toContain(JSON.stringify(expected));

  it('AC-1: reports an ungated approvable write', () => {
    contains(isolated([route(['label.delete'], 'service', false, 'DELETE', false, 'DELETE /labels/:id')]), {
      kind: 'ungated-approvable-write', route: 'DELETE /labels/:id',
    });
  });

  it('AC-3: reports a gated route without an approvable key', () => {
    contains(isolated([route(['ticket.read'], 'service', false, 'POST', true)], [entry('ticket.read', false)]), {
      kind: 'gated-without-approvable-key', route: 'POST /x',
    });
  });

  it('AC-6: does not gate read routes', () => {
    expect(isolated([route(['approval.decide'], 'service', false, 'GET')], [entry('approval.decide', true)])).toEqual([]);
  });

  it('AC-7: uses the supplied catalog approvability', () => {
    expect(isolated([route(['label.delete'], 'service', false, 'DELETE')], [entry('label.delete', false)])).toEqual([]);
  });

  it('AC-8: approval.decide is no longer pending', () => expect(PENDING_SURFACE_KEYS.has('approval.decide')).toBe(false));
  it('AC-14: audit.read is no longer pending', () => expect(PENDING_SURFACE_KEYS.has('audit.read')).toBe(false));

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
    contains(findContractViolations(declarations({ routes: [route(['no.such.key'])] })), { kind: 'unknown-key', source: 'GET /x', key: 'no.such.key' });
    contains(findContractViolations(declarations({ tools: [{ tool: 'koda_x', key: 'no.such.key' }] })), { kind: 'unknown-key', source: 'koda_x', key: 'no.such.key' });
    contains(findContractViolations(declarations({ systemWriters: [{ writer: 'XSweeper', key: 'no.such.key' }] })), { kind: 'unknown-key', source: 'XSweeper', key: 'no.such.key' });
  });

  it('requires a guard only when a route is guard-enforced', () => {
    const catalog = [{ key: 'k.one' }] as const;
    contains(findContractViolations(declarations({ routes: [route(['k.one'], 'guard', false)] }), catalog, new Set()), { kind: 'guard-missing', route: 'GET /x' });
    expect(findContractViolations(declarations({ routes: [route(['k.one'], 'service', false)] }), catalog, new Set()).some(({ kind }) => kind === 'guard-missing')).toBe(false);
  });

  it('reports exactly the catalog key not declared by a route', () => {
    const violations = findContractViolations(declarations({ routes: [route(['k.one'])] }), [{ key: 'k.one' }, { key: 'k.two' }], new Set());
    expect(asSet(violations)).toEqual(new Set([JSON.stringify({ kind: 'unused-key', key: 'k.two' })]));
  });

  it('still checks unused catalog keys when a route lacks Requires metadata', () => {
    const violations = findContractViolations(declarations({ routes: [route(undefined)] }), [{ key: 'k.one' }, { key: 'k.two' }], new Set());
    contains(violations, { kind: 'unused-key', key: 'k.one' });
    contains(violations, { kind: 'unused-key', key: 'k.two' });
  });

  it('exempts pending keys until declared, then reports the pending declaration', () => {
    const catalog = [{ key: 'k.one' }, { key: 'k.two' }] as const;
    const pending = new Set(['k.two']);
    expect(findContractViolations(declarations({ routes: [route(['k.one'])] }), catalog, pending)).toEqual([]);
    contains(findContractViolations(declarations({ routes: [route(['k.one', 'k.two'])] }), catalog, pending), { kind: 'pending-key-declared', source: 'GET /x', key: 'k.two' });
  });

  it('counts tools and system writers as declarations', () => {
    expect(findContractViolations(declarations({ tools: [{ tool: 'koda_x', key: 'k.one' }], systemWriters: [{ writer: 'XSweeper', key: 'k.two' }] }), [{ key: 'k.one' }, { key: 'k.two' }], new Set())).toEqual([]);
  });
});
