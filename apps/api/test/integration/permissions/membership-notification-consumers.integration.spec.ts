/**
 * Permissions P1b US-005 — notification eligibility, ticket mentions and the MEMBER_ADDED email read
 * the compatibility union (AC-1 .. AC-7), over real Postgres and the real entry points.
 *
 * Every principal here has exactly one kind of source in the project under test, so an AC passes only
 * when the reader consults the access sources: `NotificationWriter.deliver` (through
 * `NotificationEligibility.filter`), `TicketMentionResolver.mentionedUserIds` and
 * `EmailContentBuilder.build` for MEMBER_ADDED on one side, and the compatibility queries in
 * `src/permissions/membership.queries.ts` on the other. Sources are real rows — bindings
 * through `MembershipService.createBinding` and the fixture module's `grantRole`/`grantBaseline`
 * (booting `AppModule` runs `SystemRoleSeeder`, so the seeded role keys exist), and deliberately no
 * legacy `ProjectMember` row anywhere in this spec.
 *
 * The actor of every draft is a user of its own, so the "never the actor" filter is out of the way of
 * the ACs and only the recipient's sources decide.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/membership-notification-consumers.integration.spec.ts
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AppModule } from '../../../src/app.module';
import { EmailContentBuilder } from '../../../src/email/email-content.builder';
import type { EmailScheduleRow } from '../../../src/email/schedule/email-schedule.types';
import { NotificationWriter } from '../../../src/notifications/notification-writer';
import { TicketMentionResolver } from '../../../src/notifications/ticket-mention.resolver';
import type { NotificationDraft } from '../../../src/notifications/notification.types';
import { MembershipService } from '../../../src/permissions/membership.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
/** `EmailContentBuilder` needs an absolute web URL; `WEB_PUBLIC_URL` is unset by default. */
const WEB_PUBLIC_URL = 'https://koda.test';

describeIntegration('notification, mention and email consumers read bindings (US-005, PG)', () => {
  let nest: TestingModule;
  let app: INestApplication;
  let prisma: PrismaClient;
  let writer: NotificationWriter;
  let mentions: TicketMentionResolver;
  let builder: EmailContentBuilder;
  let membership: MembershipService;

  let p1Id = '';
  let previousWebPublicUrl: string | undefined;
  const ids: Record<string, string> = {};

  const userPrincipal = (who: string): PrincipalRef => ({ type: 'USER', id: ids[who] as string });
  const bind = (principal: PrincipalRef, roleKey: string, projectId: string | null) =>
    membership.createBinding({ principal, roleKey, projectId }, { type: 'USER', id: ids.granter as string });

  /**
   * A user of the fixture: the member baseline every principal production creates carries, plus the
   * global admin binding for the admins (whose mirror keeps `User.role` at `ADMIN`).
   */
  const makeUser = async (who: string, admin = false): Promise<string> => {
    const user = await prisma.user.create({
      data: { email: `${who}-${randomUUID()}@koda.test`, name: who, passwordHash: 'x' },
    });
    await grantBaseline(prisma, { type: 'USER', id: user.id });
    if (admin) await grantRole(prisma, { type: 'USER', id: user.id }, 'admin', null);
    return user.id;
  };

  /**
   * The principal's **access sources from bindings**: the PROJECT-scope bindings it holds, in the
   * project and `projectId`-null. A GLOBAL-scope binding is never a source, which is why the filter
   * below never hides one that would make an AC pass for the wrong reason.
   */
  const projectBindingsOf = (userId: string) =>
    prisma.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, role: { scope: 'PROJECT' } },
      select: { projectId: true, role: { select: { key: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  /** The ACs' premise: no legacy `ProjectMember` row, and the only source is the named binding. */
  const expectOnlyProjectBinding = async (
    userId: string,
    projectId: string | null,
    roleKey: string,
  ): Promise<void> => {

    expect(await projectBindingsOf(userId)).toEqual([{ projectId, role: { key: roleKey } }]);
  };

  /** An enabled user whose only source in p1 could be a binding — and here has none. */
  const expectNoSource = async (userId: string): Promise<void> => {
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).disabled).toBe(false);
    expect(await projectBindingsOf(userId)).toEqual([]);

  };

  const draft = (userId: string, over: Partial<NotificationDraft> = {}): NotificationDraft => ({
    userId,
    projectId: p1Id,
    category: 'ASSIGNED',
    kind: 'ticket_assigned',
    title: 'Assigned',
    body: null,
    link: `/${P1_SLUG}/tickets/${P1_KEY}-1`,
    params: {},
    sourceType: 'ticket_event',
    sourceId: `evt-${randomUUID()}`,
    actorId: ids.actor as string,
    ...over,
  });

  const mention = (who: string): string => `@[${who}](user:${ids[who] as string}) look here`;

  const memberAddedRow = (userId: string): EmailScheduleRow => ({
    id: `s-${randomUUID()}`,
    kind: 'MEMBER_ADDED',
    notificationId: null,
    inviteId: null,
    userId,
    projectId: p1Id,
    toEmail: 'member@koda.test',
    locale: 'en',
    attempts: 1,
    dueAt: new Date('2026-10-10T12:05:00Z'),
  });

  beforeAll(async () => {
    previousWebPublicUrl = process.env['WEB_PUBLIC_URL'];
    process.env['WEB_PUBLIC_URL'] = WEB_PUBLIC_URL;
    await resetDb();
    nest = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = nest.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService).client as PrismaClient;
    writer = app.get(NotificationWriter);
    mentions = app.get(TicketMentionResolver);
    builder = app.get(EmailContentBuilder);
    membership = app.get(MembershipService);

    p1Id = (await prisma.project.create({ data: { name: 'Project p1', slug: P1_SLUG, key: P1_KEY } })).id;

    for (const who of ['granter', 'actor', 'devBind', 'globalBind', 'outsider']) ids[who] = await makeUser(who);
    ids.admin = await makeUser('admin', true);

    await Promise.all([
      // The only source of devBind in p1. No legacy row, no GLOBAL-scope binding of its own.
      bind(userPrincipal('devBind'), 'developer', p1Id),
      // A binding with no project applies in every project: the only source of globalBind.
      bind(userPrincipal('globalBind'), 'viewer', null),
    ]);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    if (previousWebPublicUrl === undefined) delete process.env['WEB_PUBLIC_URL'];
    else process.env['WEB_PUBLIC_URL'] = previousWebPublicUrl;
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(
      prisma,
      [
        { type: 'USER', id: ids.granter as string },
        { type: 'USER', id: ids.actor as string },
        { type: 'USER', id: ids.devBind as string },
        { type: 'USER', id: ids.globalBind as string },
        { type: 'USER', id: ids.outsider as string },
        { type: 'USER', id: ids.admin as string },
      ],
      // The globalBind user's fixture under test is a projectId-null viewer binding: a PROJECT-scope
      // role bound globally, which the sentinel would otherwise refuse.
      { globalProjectRoles: [userPrincipal('globalBind')] },
    );

    // The exempt user still holds the global viewer binding this spec is about: a PROJECT-scope role
    // bound with no project, next to its GLOBAL-scope member baseline.
    const globalBindings = await prisma.roleBinding.findMany({
      where: { principalType: 'USER', principalId: ids.globalBind, projectId: null, role: { scope: 'PROJECT' } },
      select: { role: { select: { key: true } } },
    });
    expect(globalBindings.map((row) => row.role.key)).toEqual(['viewer']);
  });

  it('AC-1: deliver inserts a notification for a user whose only source in p1 is a developer binding', async () => {
    await expectOnlyProjectBinding(ids.devBind as string, p1Id, 'developer');

    const inserted = await writer.deliver([draft(ids.devBind as string)]);

    expect(inserted).toBe(1);
    const rows = await prisma.notification.findMany({ where: { userId: ids.devBind, projectId: p1Id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ kind: 'ticket_assigned', category: 'ASSIGNED' }));
  }, TEST_TIMEOUT_MS);

  it('AC-2: deliver inserts nothing for an enabled non-admin with no source, and one for an enabled global ADMIN', async () => {
    await expectNoSource(ids.outsider as string);
    await expectNoSource(ids.admin as string);

    const inserted = await writer.deliver([draft(ids.outsider as string), draft(ids.admin as string)]);

    expect(inserted).toBe(1);
    expect(await prisma.notification.count({ where: { userId: ids.outsider, projectId: p1Id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: ids.admin, projectId: p1Id } })).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('AC-3: deliver inserts a notification for a user whose only source is a projectId-null viewer binding', async () => {
    await expectOnlyProjectBinding(ids.globalBind as string, null, 'viewer');

    const inserted = await writer.deliver([draft(ids.globalBind as string)]);

    expect(inserted).toBe(1);
    expect(await prisma.notification.count({ where: { userId: ids.globalBind, projectId: p1Id } })).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('AC-4: mentionedUserIds returns a user whose only source in p1 is a developer binding', async () => {
    await expectOnlyProjectBinding(ids.devBind as string, p1Id, 'developer');

    await expect(mentions.mentionedUserIds(p1Id, mention('devBind'))).resolves.toEqual([ids.devBind]);
  }, TEST_TIMEOUT_MS);

  it('AC-5: mentionedUserIds returns nothing for an enabled non-admin user with no source in p1', async () => {
    await expectNoSource(ids.outsider as string);

    await expect(mentions.mentionedUserIds(p1Id, mention('outsider'))).resolves.toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('AC-6: MEMBER_ADDED build answers template data whose role is DEVELOPER for a developer binding', async () => {
    await expectOnlyProjectBinding(ids.devBind as string, p1Id, 'developer');

    await expect(builder.build(memberAddedRow(ids.devBind as string))).resolves.toEqual({
      data: { projectName: 'Project p1', role: 'DEVELOPER', url: `${WEB_PUBLIC_URL}/${P1_SLUG}` },
      userId: ids.devBind,
    });
  }, TEST_TIMEOUT_MS);

  it('AC-7: MEMBER_ADDED build answers skip SOURCE_GONE for a user with no source in p1', async () => {
    await expectNoSource(ids.outsider as string);

    await expect(builder.build(memberAddedRow(ids.outsider as string))).resolves.toEqual({ skip: 'SOURCE_GONE' });
  }, TEST_TIMEOUT_MS);
});
