/**
 * US-003 AC-6 — a route command's `execute` loads the principal from the action context, so the same
 * command serves the immediate run and the deferred one (which the execution service rebuilds the
 * context for). This is the seam US-002's `ActorPrincipalLoader` was built for.
 */
import type { NathApplication } from '@nathapp/nestjs-app';
import { routeCommand } from '../../../src/approvals/route/route-command';
import { ActorPrincipalLoader } from '../../../src/auth/principal/actor-principal.loader';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;

integration('routeCommand principal loading (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let loader: ActorPrincipalLoader;
  const agentId = 'route-command-agent';
  const agentActor = { type: 'AGENT', id: agentId } as const;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    loader = app.get(ActorPrincipalLoader, { strict: false });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await resetDb();
    await db.agent.create({ data: {
      id: agentId, name: 'Route command', slug: 'route-command-bot', apiKeyHash: 'route-command-hash', status: 'ACTIVE',
    } });
  });

  it('AC-6: execute under an agent action context answers what the rebuilt agent principal says', async () => {
    const command = routeCommand(
      {
        key: 'role.manage',
        variant: 'rest:route-command-probe',
        parse: (input: unknown) => input,
        run: async (principal) => principal.actorType,
      },
      loader,
    );

    await expect(withTestActor(agentActor, () => command.execute({ key: 'qa' }))).resolves.toBe('agent');
  });

  it('execute under a user action context answers the user principal type', async () => {
    const userId = 'route-command-user';
    await db.user.create({ data: { id: userId, email: 'route-command@example.test', name: 'Route', passwordHash: 'hash' } });
    const command = routeCommand(
      { key: 'role.manage', variant: 'rest:route-command-probe', parse: (input: unknown) => input, run: async (principal) => principal.actorType },
      loader,
    );

    await expect(withTestActor({ type: 'USER', id: userId }, () => command.execute({}))).resolves.toBe('user');
  });
});
