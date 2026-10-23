import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AppModule } from '../../../src/app.module';
import { NotificationEligibility } from '../../../src/notifications/notification-eligibility';
import type { NotificationDraft } from '../../../src/notifications/notification.types';
import { TicketMentionResolver } from '../../../src/notifications/ticket-mention.resolver';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const mention = (id: string) => `@[user](user:${id})`;

describeIntegration('project.read notification recipients (PG)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let db: PrismaClient;
  let membership: MembershipService;
  let eligibility: NotificationEligibility;
  let mentions: TicketMentionResolver;
  let projectId: string;
  let p2Id: string;
  let sequence = 0;
  const newUser = async (role: 'MEMBER' | 'ADMIN' = 'MEMBER', disabled = false) => {
    const n = ++sequence;
    const user = await db.user.create({ data: { email: `recipient-${n}-${randomUUID()}@koda.test`, name: `u${n}`, passwordHash: 'x', role, disabled } });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user;
  };
  const draft = (userId: string, actorId = 'actor', project = projectId): NotificationDraft => ({
    userId, projectId: project, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'assigned', body: null,
    link: '/ticket', params: {}, sourceType: 'ticket_event', sourceId: `event-${randomUUID()}`, actorId,
  });
  const customRole = (scope: 'GLOBAL' | 'PROJECT', permissions: string[]) => db.role.create({
    data: { key: `recipient-role-${++sequence}`, name: 'Custom recipient role', scope, permissions },
  });

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    membership = app.get(MembershipService);
    eligibility = app.get(NotificationEligibility);
    mentions = app.get(TicketMentionResolver);
    projectId = (await db.project.create({ data: { name: 'Recipient P', slug: 'recipient-p', key: 'RECP' } })).id;
    p2Id = (await db.project.create({ data: { name: 'Recipient P2', slug: 'recipient-p2', key: 'RCP2' } })).id;
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.roleBinding.deleteMany({});
    await db.user.deleteMany({});
    await membership.invalidatePermissions();
  });

  it('AC-1: admits a custom GLOBAL project.read holder', async () => {
    const user = await newUser();
    const role = await customRole('GLOBAL', ['project.read']);
    await grantRole(db, { type: 'USER', id: user.id }, role.key);
    expect(await eligibility.filter([draft(user.id)])).toHaveLength(1);
  });
  it('AC-2: User.role ADMIN and only global member binding is not eligible', async () => {
    const user = await newUser('ADMIN');
    expect(await eligibility.filter([draft(user.id)])).toEqual([]);
  });
  it('AC-3: custom PROJECT role without project.read is not eligible', async () => {
    const user = await newUser();
    const role = await customRole('PROJECT', ['ticket.create']);
    await grantRole(db, { type: 'USER', id: user.id }, role.key, projectId);
    expect(await eligibility.filter([draft(user.id)])).toEqual([]);
  });
  it('AC-4: a no-project draft accepts an enabled member', async () => {
    const user = await newUser();
    expect(await eligibility.filter([draft(user.id, 'actor', null)])).toHaveLength(1);
  });
  it('AC-6: global admin recipients are enabled binding holders in user creation order', async () => {
    const first = await newUser();
    const disabled = await newUser('MEMBER', true);
    const roleAdminWithoutBinding = await newUser('ADMIN');
    const second = await newUser();
    await grantRole(db, { type: 'USER', id: first.id }, 'owner');
    await grantRole(db, { type: 'USER', id: disabled.id }, 'admin');
    await grantRole(db, { type: 'USER', id: second.id }, 'admin');
    expect(await eligibility.findGlobalAdminIds()).toEqual([first.id, second.id]);
    expect(await eligibility.findGlobalAdminIds()).not.toContain(roleAdminWithoutBinding.id);
  });
  it('AC-7: a project binding in P2 does not grant eligibility in P', async () => {
    const user = await newUser();
    await grantRole(db, { type: 'USER', id: user.id }, 'developer', p2Id);
    expect(await eligibility.filter([draft(user.id)])).toEqual([]);
  });
  it('AC-10: mentions retain only project.read holders in token order', async () => {
    const viewer = await newUser();
    const legacyAdmin = await newUser('ADMIN');
    const globalAdmin = await newUser();
    await grantRole(db, { type: 'USER', id: viewer.id }, 'viewer', projectId);
    await grantRole(db, { type: 'USER', id: globalAdmin.id }, 'admin');
    expect(await mentions.mentionedUserIds(projectId, `${mention(viewer.id)} ${mention(legacyAdmin.id)} ${mention(globalAdmin.id)}`))
      .toEqual([viewer.id, globalAdmin.id]);
  });
  it('AC-11: global member binding and legacy ProjectMember do not admit a recipient', async () => {
    const user = await newUser();
    await db.projectMember.create({ data: { userId: user.id, projectId, role: 'DEVELOPER' } });
    expect(await eligibility.filter([draft(user.id)])).toEqual([]);
  });
  it('AC-12: global member binding and legacy ProjectMember do not admit a mention', async () => {
    const user = await newUser();
    await db.projectMember.create({ data: { userId: user.id, projectId, role: 'DEVELOPER' } });
    expect(await mentions.mentionedUserIds(projectId, mention(user.id))).toEqual([]);
  });
});
