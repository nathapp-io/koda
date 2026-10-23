/**
 * Permissions P1a US-003 — MembershipService against real Postgres (AC-16 .. AC-25): concurrent
 * idempotent creates, binding-derived token revocation, and the owner-row lock.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/membership-service.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AppModule } from '../../../src/app.module';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { PermissionService } from '../../../src/permissions/permission.service';
import { PrismaRoleBindingRepository } from '../../../src/permissions/prisma-role-binding.repository';
import { PrismaRoleRepository } from '../../../src/permissions/prisma-role.repository';
import { createTestPrismaClient } from '../../helpers/test-prisma';
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
      expect((await userRow(user.id)).tokenVersion).toBe(1);
    });
  });

  describe('binding-derived token revocation', () => {
    it('AC-18/19: a global admin binding promotes the derived role, bumps tokenVersion and makes isGlobalAdmin true', async () => {
      const user = await newUser();
      await bindGlobal(user.id, 'admin');
      const row = await userRow(user.id);
      expect(row.tokenVersion).toBe(1);
      expect(await membership.isGlobalAdmin(user.id)).toBe(true);
    });

    it('AC-20/21: removing the only global admin binding sets MEMBER and isGlobalAdmin false', async () => {
      const user = await newUser();
      const binding = await bindGlobal(user.id, 'admin');
      await membership.removeBinding(binding.id);
      const row = await userRow(user.id);
      expect(row.tokenVersion).toBe(2);
      expect(await membership.isGlobalAdmin(user.id)).toBe(false);
    });

    it('setGlobalAdmin(false) never removes an owner binding and does not revoke a binding-less legacy admin', async () => {
      const owner = await newUser();
      await bindGlobal(owner.id, 'owner');
      await bindGlobal(owner.id, 'admin');
      await membership.setGlobalAdmin(owner.id, false, SYSTEM);
      expect(await ownerCount()).toBe(1);
      expect((await userRow(owner.id)).tokenVersion).toBe(1);

      const legacy = await newUser('ADMIN');
      await membership.setGlobalAdmin(legacy.id, false, SYSTEM);
      expect((await userRow(legacy.id)).tokenVersion).toBe(0);
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

  describe('concurrent token revocation (B2)', () => {
    it('removing one user\'s owner and admin bindings concurrently leaves MEMBER', async () => {
      const user = await newUser();
      const [owner, admin] = [await bindGlobal(user.id, 'owner'), await bindGlobal(user.id, 'admin')];
      // A second owner keeps the last-owner rule out of the way: this test is about the user's mirror.
      await bindGlobal((await newUser()).id, 'owner');
      expect(await membership.isGlobalAdmin(user.id)).toBe(true);

      const results = await Promise.allSettled([
        membership.removeBinding(owner.id),
        membership.removeBinding(admin.id),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await prisma.roleBinding.count({ where: { principalId: user.id } })).toBe(0);
      const row = await userRow(user.id);
      // One bump for the promotion the two bindings caused, one for the demotion they now leave behind:
      // the second removal must not count the first's uncommitted delete as a surviving binding.
      expect(row.tokenVersion).toBe(2);
      expect(await membership.isGlobalAdmin(user.id)).toBe(false);
    });

    it('a removal racing a grant of the same user\'s admin side keeps the user ADMIN', async () => {
      const user = await newUser();
      const owner = await bindGlobal(user.id, 'owner');
      // A second owner keeps the last-owner rule out of the way, so the removal is about the mirror.
      await bindGlobal((await newUser()).id, 'owner');

      const [removed, granted] = await Promise.allSettled([
        membership.removeBinding(owner.id),
        bindGlobal(user.id, 'admin'),
      ]);

      expect([removed.status, granted.status]).toEqual(['fulfilled', 'fulfilled']);
      // The admin binding is there when the dust settles, so the demotion the removal may have made must
      // not outlive it: the two transactions serialize on the user's row.
      expect(await prisma.roleBinding.count({ where: { principalId: user.id, role: { key: 'admin' } } })).toBe(1);
      expect(await membership.isGlobalAdmin(user.id)).toBe(true);
      // Grant before removal keeps ADMIN throughout; removal first causes two additional flips.
      expect([1, 3]).toContain((await userRow(user.id)).tokenVersion);
    });

    it('a global admin grant committed before the bulk-removal lock is deleted and demotes the user', async () => {
      const user = await newUser();
      await bindGlobal(user.id, 'member');
      const principal = { type: 'USER' as const, id: user.id };

      // Pause at the first lock (fixed code) or after the first snapshot (the regression).
      // The grant runs from this test's outer async context, never from a repository hook: nested
      // txManager.run calls would otherwise join the removal and would not prove commit visibility.
      const repo = moduleRef.get<PrismaRoleBindingRepository>(PrismaRoleBindingRepository, { strict: false });
      const originalLockOwnerRole = repo.lockOwnerRole.bind(repo);
      const originalRead = repo.findPrincipalBindings.bind(repo);
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { reached = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      let waiting = false;
      const pauseOnce = async () => {
        if (waiting) return;
        waiting = true;
        reached();
        await resume;
      };
      repo.lockOwnerRole = async () => {
        await pauseOnce();
        return originalLockOwnerRole();
      };
      repo.findPrincipalBindings = async (ref) => {
        const rows = await originalRead(ref);
        await pauseOnce();
        return rows;
      };

      const observer = createTestPrismaClient();
      const removal = membership.removeAllBindings(principal);
      try {
        await Promise.race([
          paused,
          removal.then(() => { throw new Error('Bulk removal completed without reaching the barrier'); }),
        ]);
        const tx = moduleRef.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
        expect(tx.isInTransaction()).toBe(false);
        const grant = await bindGlobal(user.id, 'admin');
        // This independent client cannot see uncommitted changes from either service transaction.
        expect(await observer.roleBinding.findUnique({ where: { id: grant.id } })).not.toBeNull();
        expect(await observer.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(
          expect.objectContaining({ tokenVersion: 1 }),
        );
        release();
        await removal;
      } finally {
        release();
        await removal.catch(() => undefined);
        repo.lockOwnerRole = originalLockOwnerRole;
        repo.findPrincipalBindings = originalRead;
        await observer.$disconnect();
      }

      expect(await prisma.roleBinding.count({ where: { principalId: user.id } })).toBe(0);
      const row = await userRow(user.id);
      // One bump for the grant, one for the demotion it must not survive.
      expect(row.tokenVersion).toBe(2);
      expect(await membership.isGlobalAdmin(user.id)).toBe(false);
    });
  });

  describe('the commit boundary of a nested write (B3)', () => {
    /**
     * A second "request": its own connection, so its reads never join the transaction the test has open.
     * The permission cache is the module's, which is what makes the read sequence meaningful.
     */
    const anotherRequest = (cache: PermissionCache) => {
      const outside = createTestPrismaClient();
      const tx = {
        run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
        getClient: () => outside,
        isInTransaction: () => false,
      };
      return {
        service: new PermissionService(
          new PrismaRoleRepository(tx as never, { client: outside } as never),
          new PrismaRoleBindingRepository(tx as never, { client: outside } as never),
          cache,
        ),
        close: () => outside.$disconnect(),
      };
    };

    it('a nested demotion invalidates the permission cache only after the outer transaction commits', async () => {
      const cache = moduleRef.get(PermissionCache, { strict: false });
      const tx = moduleRef.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
      const reader = anotherRequest(cache);

      try {
        const user = await newUser();
        await bindGlobal(user.id, 'admin');
        const principal = { type: 'USER' as const, id: user.id };
        // Warm the cache from a request that is not inside any transaction.
        expect((await reader.service.effectiveKeys(principal, 'global')).has('user.create')).toBe(true);

        await membership.afterCommit(() =>
          tx.run(async () => {
            await membership.setGlobalAdmin(user.id, false, SYSTEM);
            // The read that makes the timing matter: between the nested write and the commit, the
            // demotion is invisible outside, so the keys are unchanged — and this read must not cache
            // them under a generation the commit will not invalidate again.
            expect((await reader.service.effectiveKeys(principal, 'global')).has('user.create')).toBe(true);
          }),
        );

        expect((await userRow(user.id)).tokenVersion).toBe(2);
        expect((await reader.service.effectiveKeys(principal, 'global')).has('user.create')).toBe(false);
      } finally {
        await reader.close();
      }
    });
  });
});
