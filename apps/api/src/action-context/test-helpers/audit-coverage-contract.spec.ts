import type { PermissionDeclarations } from '../../permissions/test-helpers/permission-contract';
import { findCoverageViolations } from './audit-coverage-contract';

describe('findCoverageViolations', () => {
  const declarations = (routes: string[] = [], writers: string[] = []): PermissionDeclarations => ({
    routes: routes.map((route) => ({ route, requires: undefined, hasRequiresGuard: false })),
    tools: [{ tool: 'example', key: 'example' }],
    systemWriters: writers.map((writer) => ({ writer, key: 'system.example' })),
  });

  it('AC-1: reports an allowlisted route that is not live', () => {
    expect(findCoverageViolations(declarations(), new Map([['POST /gone', 'reason']]), new Set())).toEqual([
      { kind: 'stale-surface', surface: 'POST /gone' },
    ]);
  });

  it('AC-2: rejects allowlisted GET routes', () => {
    expect(findCoverageViolations(declarations(['GET /me/notifications']), new Map([['GET /me/notifications', 'reason']]), new Set())).toEqual([
      { kind: 'read-route-allowlisted', surface: 'GET /me/notifications' },
    ]);
  });

  it('AC-3: accepts a live system writer class', () => {
    expect(findCoverageViolations(declarations([], ['EmailDispatcher']), new Map([['writer:EmailDispatcher', 'reason']]), new Set())).toEqual([]);
  });

  it('AC-4: reports a missing system writer class', () => {
    expect(findCoverageViolations(declarations(), new Map([['writer:Missing', 'reason']]), new Set())).toEqual([
      { kind: 'stale-surface', surface: 'writer:Missing' },
    ]);
  });

  it('AC-5: validates system actor ids', () => {
    expect(findCoverageViolations(declarations(), new Map([['system:outbox', 'reason']]), new Set(['outbox']))).toEqual([]);
    expect(findCoverageViolations(declarations(), new Map([['system:nope', 'reason']]), new Set())).toEqual([
      { kind: 'stale-surface', surface: 'system:nope' },
    ]);
  });

  it('AC-6: reports an empty reason for a live route', () => {
    expect(findCoverageViolations(declarations(['POST /x']), new Map([['POST /x', '  ']]), new Set())).toEqual([
      { kind: 'empty-reason', surface: 'POST /x' },
    ]);
  });

  it('AC-8: treats task labels as stale surfaces', () => {
    expect(findCoverageViolations(declarations(), new Map([['task:PrAttributionService.attribute', 'reason']]), new Set())).toEqual([
      { kind: 'stale-surface', surface: 'task:PrAttributionService.attribute' },
    ]);
  });
});
