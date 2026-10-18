/**
 * Permissions P1a US-003 — MembershipService against real Postgres (AC-16 .. AC-25): concurrent
 * idempotent creates, legacy User.role mirroring with token revocation, and the owner-row lock.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/membership-service.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('MembershipService (PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let counter = 0;

  const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
  const newUser = async (role: 'MEMBER' | 'ADMIN' = 'MEMBER') => {
    counter += 1;
    return prisma.user.create({
      data: { email: `m${counter}@koda.test`, name: `M${counter}`, passwordHash: 'x', role },
    });
  };
  const bindGlobal = (userId: string, roleKey: string) =>
    membership.createBinding({ principal: { type: 'USER', id: userId }, roleKey, projectId: null }, SYSTEM);
  const ownerCount = () => prisma.roleBinding.count({ where: { role: { key: 'owner' } } });
  const userRow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService<PrismaClient>, { strict: false }).client as PrismaClient;
    membership = moduleRef.get(MembershipService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.roleBinding.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.project.deleteMany({});
  });

  describe('concurrent createBinding', () => {
    const racePair = async () => {
      const user = await newUser();
      const project = await prisma.project.create({ data: { name: 'P', slug: `p-${user.id}`, key: 'P' } });
      const input = { principal: { type: 'USER' as const, id: user.id }, roleKey: 'developer', projectId: project.id };
      const results = await Promise.all([membership.createBinding(input, SYSTEM), membership.createBinding(input, SYSTEM)]);
      return { user, results };
    };

    it('AC-16: both calls resolve to views with the same id', async () => {
      const { results } = await racePair();
      expect(results[0].id).toBe(results[1].id);
    });

    it('AC-17: exactly one matching row exists afterwards', async () => {
      const { user } = await racePair();
      expect(await prisma.roleBinding.count({ where: { principalId: user.id } })).toBe(1);
    });

    it('a global admin race leaves one binding and an ADMIN user', async () => {
      const user = await newUser();
      const [a, b] = await Promise.all([bindGlobal(user.id, 'admin'), bindGlobal(user.id, 'admin')]);
      expect(a.id).toBe(b.id);
      expect((await userRow(user.id)).role).toBe('ADMIN');
    });
  });

  describe('legacy admin mirroring', () => {
    it('AC-18/19: a global admin binding sets User.role ADMIN, bumps tokenVersion and makes isGlobalAdmin true', async () => {
      const user = await newUser();
      await bindGlobal(user.id, 'admin');
      const row = await userRow(user.id);
      expect(row.role).toBe('ADMIN');
      expect(row.tokenVersion).toBe(1);
      expect(await membership.isGlobalAdmin(user.id)).toBe(true);
    });

    it('AC-20/21: removing the only global admin binding sets MEMBER and isGlobalAdmin false', async () => {
      const user = await newUser();
      const binding = await bindGlobal(user.id, 'admin');
      await membership.removeBinding(binding.id);
      const row = await userRow(user.id);
      expect(row.role).toBe('MEMBER');
      expect(row.tokenVersion).toBe(2);
      expect(await membership.isGlobalAdmin(user.id)).toBe(false);
    });

    it('setGlobalAdmin(false) never removes an owner binding and demotes a binding-less legacy admin', async () => {
      const owner = await newUser();
      await bindGlobal(owner.id, 'owner');
      await bindGlobal(owner.id, 'admin');
      await membership.setGlobalAdmin(owner.id, false, SYSTEM);
      expect(await ownerCount()).toBe(1);
      expect((await userRow(owner.id)).role).toBe('ADMIN');

      const legacy = await newUser('ADMIN');
      await membership.setGlobalAdmin(legacy.id, false, SYSTEM);
      expect((await userRow(legacy.id)).role).toBe('MEMBER');
    });
  });

  describe('owner protection', () => {
    it('AC-22/23: the last enabled owner binding is refused with permissions.ownerLocked and stays', async () => {
      const user = await newUser();
      const binding = await bindGlobal(user.id, 'owner');
      const error = await membership.removeBinding(binding.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(JSON.stringify(error)).toContain('permissions.ownerLocked');
      expect(await ownerCount()).toBe(1);
    });

    it('AC-24/25: concurrent removals of two owner bindings leave exactly one and reject one with ownerLocked', async () => {
      const [first, second] = [await newUser(), await newUser()];
      const [a, b] = [await bindGlobal(first.id, 'owner'), await bindGlobal(second.id, 'owner')];

      const results = await Promise.allSettled([membership.removeBinding(a.id), membership.removeBinding(b.id)]);

      expect(await ownerCount()).toBe(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ForbiddenAppException);
      expect(JSON.stringify(rejected[0]?.reason)).toContain('permissions.ownerLocked');
    });
  });
});
