import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { NOTIFY_SERVICE } from '@nathapp/nestjs-notify';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { EmailDispatcher } from '../../../src/email/email-dispatcher';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; redeem: boolean }
interface Settled { id: string; status: string; result: { outcome?: string; emailed?: boolean } }

// SMTP must be configured before AppModule boot so InviteMailer is enabled.
describeIntegration('invite email after approval commit (US-005)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const previousEnv = {
    SMTP_URL: process.env.SMTP_URL,
    EMAIL_FROM: process.env.EMAIL_FROM,
    WEB_PUBLIC_URL: process.env.WEB_PUBLIC_URL,
  };
  const server = () => app.getHttpServer();
  const address = () => `invite-${randomUUID()}@koda.test`;

  beforeAll(async () => {
    process.env.SMTP_URL = 'smtp://127.0.0.1:2525';
    process.env.EMAIL_FROM = 'koda@example.com';
    process.env.WEB_PUBLIC_URL = 'https://koda.example.com';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'invite.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
    vi.spyOn(app.get(NOTIFY_SERVICE), 'send').mockResolvedValue({} as never);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (previousEnv.SMTP_URL === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = previousEnv.SMTP_URL;
    if (previousEnv.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousEnv.EMAIL_FROM;
    if (previousEnv.WEB_PUBLIC_URL === undefined) delete process.env.WEB_PUBLIC_URL;
    else process.env.WEB_PUBLIC_URL = previousEnv.WEB_PUBLIC_URL;
  });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-7/8: approved agent invite records emailed false and sends exactly one invite after commit', async () => {
    const inviteEmail = address();
    await seedWaitPolicy(db, 'invite.create', world.projectId);
    const pendingResponse = await request(server()).post('/api/projects/web/invites')
      .auth(agent.apiKey, { type: 'bearer' }).send({ email: inviteEmail, roleKey: 'viewer' }).expect(202);
    const pending = data<Pending>(pendingResponse);
    expect(pending).toMatchObject({ permissionKey: 'invite.create', redeem: true });

    const decision = await request(server()).post(`/api/approvals/${pending.id}/decisions`)
      .auth(world.tokens.root, { type: 'bearer' }).send({ decision: 'approve' }).expect(200);
    const settled = data<Settled>(decision);
    // Decision route returns the approval record; read the persisted execution result after the
    // decision has synchronously executed its approved command.
    const persisted = await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(settled.id).toBe(pending.id);
    expect(persisted).toMatchObject({ status: 'executed', result: { outcome: 'INVITED', emailed: false } });

    const invite = await db.projectInvite.findFirstOrThrow({ where: { email: inviteEmail } });
    const schedules = await db.emailSchedule.findMany({ where: { inviteId: invite.id, kind: 'INVITE' } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].status).toBe('SENT');
    expect(app.get(NOTIFY_SERVICE).send).toHaveBeenCalledTimes(1);
    // Exercise the actual dispatcher dependency, not a mocked InviteMailer.
    expect(app.get(EmailDispatcher)).toBeDefined();
  });
});
