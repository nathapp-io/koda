import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-007 — the permission contract over the booted API.
 *
 * The contract test is the safety net of the permissions P1 catalog: every route, every registered
 * assistant tool and every system writer must declare a catalog key, no catalog key may stay
 * undeclared, and a guard-enforced route must actually register `RequiresGuard`. This file boots
 * the real application (one boot for the whole suite), collects the declarations off the live
 * Nest container and asserts the contract holds.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/permission-contract.integration.spec.ts
 */
import { ModulesContainer } from '@nestjs/core';
import type { NathApplication } from '@nathapp/nestjs-app';
import { AuthController } from '../../../src/auth/auth.controller';
import { AssistantToolRegistry } from '../../../src/fleet/assistant/assistant-tool.registry';
import {
  collectPermissionDeclarations,
  findContractViolations,
  type PermissionDeclarations,
} from '../../../src/permissions/test-helpers/permission-contract';
import { PERMISSION_CATALOG } from '../../../src/permissions/catalog';
import { routeSurface } from '../../../src/permissions/route-surface';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const TIMEOUT = 120_000;

describeIntegration('permission contract over the booted API (US-011)', () => {
  let app: NathApplication;
  let declarations: PermissionDeclarations;
  const previousStrategy = process.env.FTS_OPTIMIZE_STRATEGY;

  beforeAll(async () => {
    // The default strategy is `counter`; pin it so the factory-built writer assertion holds on a
    // machine that exports another strategy. The previous value is restored in `afterAll`.
    process.env.FTS_OPTIMIZE_STRATEGY = 'counter';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    // Collected after `init`, so the tool groups have registered their tools and the factories
    // have built their instances.
    declarations = collectPermissionDeclarations(
      app.get(ModulesContainer),
      app.get(AssistantToolRegistry),
    );
  }, TIMEOUT);

  afterAll(async () => {
    if (previousStrategy === undefined) delete process.env.FTS_OPTIMIZE_STRATEGY;
    else process.env.FTS_OPTIMIZE_STRATEGY = previousStrategy;
    await app?.close();
  });

  it('AC-14: finds no contract violation in the booted app', () => {
    // The walk must cover the whole app: an empty collection would report every catalog key as
    // unused, but a partial one could hide a route. These counts keep the assertion honest.
    expect(declarations.routes.length).toBeGreaterThan(200);
    expect(declarations.tools.length).toBeGreaterThan(0);
    expect(declarations.systemWriters.length).toBeGreaterThanOrEqual(30);
    expect(findContractViolations(declarations)).toEqual([]);
  });

  // 126 after fleet auto-review added `PATCH /fleet/repos/:id/auto-review` (US-010 deleted the fleet
  // adapter's gated decide route before it); the openapi contract spec
  // (`approval-openapi.contract.spec.ts`) asserts the same 126 gated operations.
  it('AC-12 (US-007): collects exactly 126 gated routes over the booted app', () => {
    expect(declarations.routes.filter((route) => route.gated).length).toBe(126);
  });

  it('AC-2: reports no permission contract violations over the booted app', () => {
    expect(findContractViolations(declarations)).toEqual([]);
  });

  it('AC-3: gates every approvable write route over the booted app', () => {
    const approvableKeys = new Set(PERMISSION_CATALOG.filter((entry) => entry.approval?.approvable).map((entry) => entry.key));
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const approvableWrites = declarations.routes.filter((route) =>
      writeMethods.has(route.method) && (route.requires?.keys ?? []).some((key) => approvableKeys.has(key)),
    );

    expect(approvableWrites.length).toBeGreaterThan(0);
    expect(approvableWrites.filter((route) => !route.gated)).toEqual([]);
  });

  it('FM-1 (US-011): catches an unlisted ungated approvable write', () => {
    const route = {
      route: 'DELETE /projects/:slug/new-high-risk-resource',
      method: 'DELETE',
      gated: false,
      requires: { keys: ['project.delete'] as const, mode: 'all' as const, enforcedBy: 'guard' as const },
      hasRequiresGuard: true,
    };
    expect(findContractViolations({ routes: [route], tools: [], systemWriters: [] })).toContainEqual({
      kind: 'ungated-approvable-write', route: route.route,
    });
  });

  it('AC-7: declares runner.sync, thread.read, role.binding.owner and system.schedule.dispatch', () => {
    const keys = new Set([
      ...declarations.routes.flatMap((route) => route.requires?.keys ?? []),
      ...declarations.systemWriters.map((writer) => writer.key),
    ]);
    for (const key of [
      'runner.sync',
      'thread.read',
      'role.binding.owner',
      'system.schedule.dispatch',
    ]) {
      expect(keys.has(key), `declared key ${key}`).toBe(true);
    }
  });

  it('AC-8: collects the factory-built CounterOptimizeStrategy as a system writer', () => {
    expect(declarations.systemWriters).toContainEqual({
      writer: 'CounterOptimizeStrategy',
      key: 'system.rag.optimize',
    });
  });

  // US-010 AC-3: one label function feeds both readers, so the walker's string and the request
  // interceptor's audit-scope surface can never name one route two ways. `POST /auth/logout` is the
  // proof because it is a live authenticated write route that records.
  it('AC-3 (US-010): labels AuthController.logout as POST /auth/logout for both readers', () => {
    const surface = routeSurface(AuthController, AuthController.prototype.logout);
    const collected = declarations.routes.filter((route) => route.route === surface);

    expect(surface).toBe('POST /auth/logout');
    expect(collected).toHaveLength(1);
    // The handler's own `@Requires`, so the collected label is bound to the method routeSurface read.
    expect(collected[0]?.requires?.keys).toEqual(['session.logout']);
  });
});
