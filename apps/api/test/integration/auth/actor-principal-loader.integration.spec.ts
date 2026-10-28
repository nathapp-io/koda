import { canRunDbTests } from '../../helpers/test-environment';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ActorPrincipalLoader, ActorUnavailableError } from '../../../src/auth/principal/actor-principal.loader';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const integration = canRunDbTests() ? describe : describe.skip;

integration('ActorPrincipalLoader (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let loader: ActorPrincipalLoader;
  const userId = 'loader-user';
  const agentId = 'loader-agent';
  const userActor = { type: 'USER', id: userId } as const;
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
    await db.user.create({ data: { id: userId, email: 'loader@example.test', name: 'Loader', passwordHash: 'hash' } });
    await db.agent.create({ data: { id: agentId, name: 'Loader', slug: 'loader-bot', apiKeyHash: 'loader-hash', status: 'ACTIVE' } });
  });

  it('AC-1: global administrator binding reconstructs an ADMIN user principal', async () => {
    await grantRole(db, userActor, 'admin', null);
    await expect(loader.load(userActor)).resolves.toMatchObject({ actorType: 'user', id: userId, email: 'loader@example.test', role: 'ADMIN', revoked: false });
  });

  it('AC-2: a project-only developer binding reconstructs a MEMBER', async () => {
    const project = await db.project.create({ data: { name: 'Loader project', slug: 'loader-project', key: 'LDR' } });
    await grantRole(db, userActor, 'developer', project.id);
    await expect(loader.load(userActor)).resolves.toMatchObject({ actorType: 'user', role: 'MEMBER' });
  });

  it('AC-3 and AC-4: disabled and missing users are unavailable', async () => {
    await db.user.update({ where: { id: userId }, data: { disabled: true } });
    await expect(loader.load(userActor)).rejects.toBeInstanceOf(ActorUnavailableError);
    await expect(loader.load({ type: 'USER', id: 'missing-user' })).rejects.toBeInstanceOf(ActorUnavailableError);
  });

  it('AC-5: an active agent is rebuilt without capabilities', async () => {
    expect(await loader.load(agentActor)).toMatchObject({ actorType: 'agent', id: agentId, slug: 'loader-bot', status: 'ACTIVE', blacklisted: false, capabilities: [] });
  });

  it('AC-6 and AC-11: paused and missing agents are unavailable', async () => {
    await db.agent.update({ where: { id: agentId }, data: { status: 'PAUSED' } });
    await expect(loader.load(agentActor)).rejects.toBeInstanceOf(ActorUnavailableError);
    await expect(loader.load({ type: 'AGENT', id: 'missing-agent' })).rejects.toBeInstanceOf(ActorUnavailableError);
  });

  it('AC-10: a pending command whose actor is paused after approval settles with ActorUnavailableError', async () => {
    await grantKeys(db, agentActor, ['role.manage'], null);
    await grantRole(db, userActor, 'admin', null);
    const gate = app.get(ApprovalGate, { strict: false });
    const decisions = app.get(ApprovalDecisionService, { strict: false });
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    const command = {
      key: 'role.manage',
      parse: (input: unknown) => input as { id: string },
      execute: async () => loader.forContext(),
    };
    registry.register(command);
    const opened = await withTestActor(agentActor, () => gate.gate('role.manage', { id: 'deferred' }, { projectId: null }));
    if (opened.status !== 'pending') throw new Error('Expected an approval request');
    await db.agent.update({ where: { id: agentId }, data: { status: 'PAUSED' } });
    const result = await withTestActor(userActor, () => decisions.decide(opened.request.id, 'approve', null));
    expect(result).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'ActorUnavailableError' } });
  });
});
