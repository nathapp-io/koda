import type { Mock } from 'vitest';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../generated/prisma/client';
import { UsersAdminService } from './users-admin.service';
import { MembershipService } from '../permissions/membership.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { UserAdminRecord } from './domain/user-admin.domain';

const user = (over: Partial<UserAdminRecord> = {}): UserAdminRecord => ({
  id: 'u2', email: 'u2@koda.test', name: 'U2', role: 'MEMBER', disabled: false,
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('UsersAdminService', () => {
  let repo: Record<string, Mock>;
  let cache: { invalidate: Mock };
  let membership: { bindBaseline: Mock; setGlobalAdmin: Mock; isGlobalAdmin: Mock; afterCommit: Mock };
  let service: UsersAdminService;
  /** The row `findById`/`updateUser` serve, so the service's reads reflect what was stored. */
  let stored: UserAdminRecord;

  beforeEach(() => {
    stored = user();
    repo = {
      findUserPage: vi.fn(),
      findById: vi.fn(async () => stored),
      findByEmail: vi.fn(),
      createUser: vi.fn(),
      countActiveAdmins: vi.fn(),
      updateUser: vi.fn(async (id: string, w: { disabled?: boolean }) => ({ ...stored, id, ...w })),
      lockUserAdministration: vi.fn(),
    };
    cache = { invalidate: vi.fn() };
    membership = {
      bindBaseline: vi.fn(),
      setGlobalAdmin: vi.fn(),
      isGlobalAdmin: vi.fn().mockResolvedValue(false),
      // B3/B4: the writes run inside `update`'s transaction and `create`'s own one; the stub runs the
      // callback and flushes nothing, exactly as the real service does when it defers nothing.
      afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
    };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    // Permissions P1a (US-004): MembershipService is the required fourth parameter.
    service = new UsersAdminService(repo as never, txManager as never, cache as never, membership as never);
  });

  describe('create', () => {
    it('hashes the password and never returns it', async () => {
      // A record carrying an extra passwordHash proves UserAdminDto.from drops it.
      repo.createUser.mockImplementation(async (d: { passwordHash: string }) => ({ ...user(), passwordHash: d.passwordHash }));
      const dto = await service.create({ email: 'n@k.t', name: 'N', password: 'Admin1234!Aa' });
      const written = repo.createUser.mock.calls[0][0];
      expect(written.passwordHash).not.toBe('Admin1234!Aa');
      expect(dto).not.toHaveProperty('passwordHash');
    });

    it('maps a duplicate email to ConflictAppException', async () => {
      repo.createUser.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002', clientVersion: 'test', meta: { target: ['email'] },
      }));
      await expect(service.create({ email: 'd@k.t', name: 'D', password: 'Admin1234!Aa' }))
        .rejects.toBeInstanceOf(ConflictAppException);
    });

    it('normalises the email to lower case before writing', async () => {
      repo.createUser.mockImplementation(async (d: { email: string }) => ({ ...user(), email: d.email }));

      const created = await service.create({ email: '  Mixed@K.T ', name: 'M', password: 'Admin1234!Aa' });

      expect(repo.findByEmail).toHaveBeenCalledWith('mixed@k.t');
      expect(repo.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'mixed@k.t' }));
      expect(created.email).toBe('mixed@k.t');
    });

    it('rejects a case-variant duplicate before the unique index is reached', async () => {
      repo.findByEmail.mockResolvedValue({ id: 'existing' });

      await expect(service.create({ email: 'Dup@K.T', name: 'D', password: 'Admin1234!Aa' }))
        .rejects.toBeInstanceOf(ConflictAppException);

      expect(repo.createUser).not.toHaveBeenCalled();
    });

    /**
     * US-005: the request has no role any more, so every created account is the least-privileged
     * member — the row says MEMBER and the only binding is the baseline. A global admin is a
     * `POST /role-bindings` grant afterwards, so `create` never promotes.
     */
    it('AC-1 and AC-2: writes MEMBER, binds the member baseline and grants no admin binding', async () => {
      repo.createUser.mockResolvedValue(user({ id: 'new-member', role: 'MEMBER' }));

      const created = await service.create({ email: 'm@k.t', name: 'M', password: 'Admin1234!Aa' });

      expect(repo.createUser).toHaveBeenCalledWith(expect.objectContaining({ role: 'MEMBER' }));
      expect(membership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'new-member' });
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(created.role).toBe('MEMBER');
    });

    it('B4: runs the user row and its bindings in one commit-aware transaction', async () => {
      repo.createUser.mockResolvedValue(user({ id: 'new-member' }));

      await service.create({ email: 'm@k.t', name: 'M', password: 'Admin1234!Aa' });

      // The binding write is nested inside the create transaction; only the outer scope may invalidate
      // the permission cache, and only once that transaction committed.
      expect(membership.afterCommit).toHaveBeenCalled();
    });

    it('B4: a failed baseline binding rejects instead of returning a user', async () => {
      repo.createUser.mockResolvedValue(user({ id: 'new-member' }));
      membership.bindBaseline.mockRejectedValueOnce(new NotFoundAppException({}, 'permissions.roleNotFound'));

      await expect(
        service.create({ email: 'm@k.t', name: 'M', password: 'Admin1234!Aa' }),
      ).rejects.toBeInstanceOf(NotFoundAppException);

      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    /**
     * US-005: `disabled` is the only patchable field, so a self-disable is the only self-patch the
     * rule refuses. A patch that asks for a role changes nothing, so it is not a refusal.
     */
    it('refuses a self-disable and accepts every other self-patch', async () => {
      await expect(service.update('u1', 'u1', { disabled: true })).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(repo.updateUser).not.toHaveBeenCalled();

      await expect(service.update('u1', 'u1', { disabled: false })).resolves.toBeDefined();
      expect(repo.updateUser).toHaveBeenCalledWith('u1', { disabled: false, bumpTokenVersion: false });
    });

    it('404s an unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('u1', 'nope', { disabled: true })).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('refuses to disable the last active admin, under the lock', async () => {
      stored = user({ role: 'ADMIN' });
      membership.isGlobalAdmin.mockResolvedValue(true);
      repo.countActiveAdmins.mockResolvedValue(1);

      await expect(service.update('u1', 'u2', { disabled: true })).rejects.toBeInstanceOf(ConflictAppException);
      expect(repo.lockUserAdministration).toHaveBeenCalled();
      expect(repo.lockUserAdministration.mock.invocationCallOrder[0]).toBeLessThan(repo.countActiveAdmins.mock.invocationCallOrder[0]);
      expect(repo.updateUser).not.toHaveBeenCalled();
      // The refusal must not have touched any binding either.
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
    });

    it('disables an admin when another active admin remains, bumping tokenVersion', async () => {
      stored = user({ role: 'ADMIN' });
      membership.isGlobalAdmin.mockResolvedValue(true);
      repo.countActiveAdmins.mockResolvedValue(2);

      await service.update('u1', 'u2', { disabled: true });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: true, bumpTokenVersion: true });
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(cache.invalidate).toHaveBeenCalledWith('USER:u2', { mode: 'tag' });
      // MEMORY-strategy fallback: evict the 60 s auth-state entry directly.
      expect(cache.invalidate).toHaveBeenCalledWith(['user-auth-state', 'u2']);
    });

    it('re-enables a disabled user without bumping tokenVersion again', async () => {
      stored = user({ disabled: true });

      await service.update('u1', 'u2', { disabled: false });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: false, bumpTokenVersion: false });
      expect(membership.isGlobalAdmin).not.toHaveBeenCalled();
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });

    /**
     * US-005: `update` never calls `setGlobalAdmin`, so no patch can promote or demote. The row it
     * returns is what it read back — a legacy `role: 'ADMIN'` on the row is not a promotion.
     */
    it('never touches a binding, whatever the stored row says', async () => {
      stored = user({ role: 'ADMIN' });
      membership.isGlobalAdmin.mockResolvedValue(true);
      repo.countActiveAdmins.mockResolvedValue(2);

      const updated = await service.update('u1', 'u2', { disabled: false });

      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: false, bumpTokenVersion: false });
      expect(updated.role).toBe('ADMIN');
    });

    it('does not count admins when isGlobalAdmin is false, even for legacy ADMIN', async () => {
      stored = user({ role: 'ADMIN' });
      membership.isGlobalAdmin.mockResolvedValue(false);
      await service.update('u1', 'u2', { disabled: true });
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });
  });
});
