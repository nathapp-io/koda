import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-002 — the shared fleet fixtures grant through role bindings only.
 *
 * `seedFleetBase`, `seedFleetHttpWorld` and `seedFleetHttpAgent` are the fixtures of ninety-odd
 * specs, so this file is the seam they all cross: the HTTP route decides on the binding, the legacy
 * rows are gone, and `expectBindingOnlyFixtures` resolves for every principal the fixtures create.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/fleet/fleet-fixtures-bindings.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { PermissionService } from '../../../src/permissions/permission.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { rosterFleetAgent, seedFleetBase, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

/** `projects` declares no 40003 sentence, so the i18n lookup answers the key itself. */
const PROJECTS_FORBIDDEN = 'projects.40003';

const user = (id: string): PrincipalRef => ({ type: 'USER', id });
const agent = (id: string): PrincipalRef => ({ type: 'AGENT', id });

describeIntegration('fleet fixtures grant through bindings (PG, US-002)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const as = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  /** The role keys of the principal's bindings in one project. */
  const roleKeysIn = async (principal: PrincipalRef, projectId: string): Promise<string[]> =>
    (await prisma.roleBinding.findMany({
      where: { principalType: principal.type, principalId: principal.id, projectId },
      include: { role: { select: { key: true } } },
    })).map((row) => row.role.key).sort();

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: the world grants the ticket list through bindings: dev and viewer read it, an outsider is refused', async () => {
    await request(app.getHttpServer()).get('/api/projects/web/tickets').set(as('dev')).expect(200);
    await request(app.getHttpServer()).get('/api/projects/web/tickets').set(as('viewer')).expect(200);

    const res = await request(app.getHttpServer()).get('/api/projects/web/tickets').set(as('outsider')).expect(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PROJECTS_FORBIDDEN);
  });

  it('AC-2: the world holds bindings only, and dev and viewer hold their project role in web', async () => {
    await expectBindingOnlyFixtures(prisma, [
      user(world.ids.root), user(world.ids.dev), user(world.ids.viewer), user(world.ids.outsider),
    ]);
    expect(await roleKeysIn(user(world.ids.dev), world.projectId)).toEqual(['developer']);
    expect(await roleKeysIn(user(world.ids.viewer), world.projectId)).toEqual(['viewer']);
  });

  it('AC-3: seedFleetBase gives its admin a global admin binding and the ADMIN mirror', async () => {
    const base = await seedFleetBase(prisma);

    await expectBindingOnlyFixtures(prisma, [user(base.adminId)]);
    const admin = await prisma.roleBinding.findFirst({
      where: { principalType: 'USER', principalId: base.adminId, projectId: null, role: { key: 'admin' } },
    });
    expect(admin).not.toBeNull();
  });

  it('AC-4: a rostered fixture agent holds its project roles as bindings and nothing else', async () => {
    const created = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);

    await rosterFleetAgent(prisma, created.id, world.projectId);

    expect(await roleKeysIn(agent(created.id), world.projectId))
      .toEqual(['developer', 'reviewer', 'triager', 'verifier', 'viewer']);
    const permissions = app.get(PermissionService, { strict: false });
    expect(await permissions.effectiveKeys(agent(created.id), { projectId: world.projectId })).toContain('ticket.create');
    expect(await permissions.effectiveKeys(agent(created.id), { projectId: world.opsProjectId })).not.toContain('ticket.create');
    await expectBindingOnlyFixtures(prisma, [agent(created.id)]);
  });
});
