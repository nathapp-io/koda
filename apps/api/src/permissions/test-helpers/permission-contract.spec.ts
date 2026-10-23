import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, PENDING_SURFACE_KEYS } from '../catalog';
import type { RequiresMetadata } from '../requires.decorator';
import {
  findContractViolations,
  type ContractViolation,
  type PermissionDeclarations,
} from './permission-contract';

describe('permission contract checker', () => {
  const expectedPending = new Set([
    'approval.decide',
    'approval.policy.read',
    'approval.policy.manage',
    'audit.read',
    'fleet.approval.decide.assistant',
    // Permissions P1 US-003 deleted the two member routes that declared this key. Removing a
    // principal from a project is now deleting its bindings, which `role.binding.manage` gates, and
    // the key waits for P3 policy to decide whether it gates binding removal.
    'member.remove',
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
  ) => ({
    route: 'GET /x',
    requires: keys === undefined ? undefined : requires(keys, enforcedBy),
    hasRequiresGuard,
  });
  const asSet = (violations: readonly ContractViolation[]) =>
    new Set(violations.map((violation) => JSON.stringify(violation)));
  const contains = (violations: readonly ContractViolation[], expected: ContractViolation) =>
    expect(asSet(violations)).toContain(JSON.stringify(expected));

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
