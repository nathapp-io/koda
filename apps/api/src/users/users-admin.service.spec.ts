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
  let membership: { bindBaseline: Mock; setGlobalAdmin: Mock };
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
    membership = { bindBaseline: vi.fn(), setGlobalAdmin: vi.fn() };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    // Permissions P1a (US-004): MembershipService is the required fourth parameter.
    service = new UsersAdminService(repo as never, txManager as never, cache as never, membership as never);
  });

  describe('create', () => {
    it('hashes the password and never returns it', async () => {
      // A record carrying an extra passwordHash proves UserAdminDto.from drops it.
      repo.createUser.mockImplementation(async (d: { passwordHash: string }) => ({ ...user(), passwordHash: d.passwordHash }));
      const dto = await service.create({ email: 'n@k.t', name: 'N', password: 'Admin1234!Aa', role: 'MEMBER' });
      const written = repo.createUser.mock.calls[0][0];
      expect(written.passwordHash).not.toBe('Admin1234!Aa');
      expect(dto).not.toHaveProperty('passwordHash');
    });

    it('maps a duplicate email to ConflictAppException', async () => {
      repo.createUser.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002', clientVersion: 'test', meta: { target: ['email'] },
      }));
      await expect(service.create({ email: 'd@k.t', name: 'D', password: 'Admin1234!Aa', role: 'MEMBER' }))
        .rejects.toBeInstanceOf(ConflictAppException);
    });

    it('normalises the email to lower case before writing', async () => {
      repo.createUser.mockImplementation(async (d: { email: string }) => ({ ...user(), email: d.email }));

      const created = await service.create({ email: '  Mixed@K.T ', name: 'M', password: 'Admin1234!Aa', role: 'MEMBER' });

      expect(repo.findByEmail).toHaveBeenCalledWith('mixed@k.t');
      expect(repo.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'mixed@k.t' }));
      expect(created.email).toBe('mixed@k.t');
    });

    it('rejects a case-variant duplicate before the unique index is reached', async () => {
      repo.findByEmail.mockResolvedValue({ id: 'existing' });

      await expect(service.create({ email: 'Dup@K.T', name: 'D', password: 'Admin1234!Aa', role: 'MEMBER' }))
        .rejects.toBeInstanceOf(ConflictAppException);

      expect(repo.createUser).not.toHaveBeenCalled();
    });

    it('binds the new member to the baseline and grants no admin binding', async () => {
      repo.createUser.mockResolvedValue(user({ id: 'new-member' }));

      await service.create({ email: 'm@k.t', name: 'M', password: 'Admin1234!Aa', role: 'MEMBER' });

      expect(membership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'new-member' });
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
    });

    it('grants a global admin binding through setGlobalAdmin when the DTO asks for ADMIN', async () => {
      repo.createUser.mockResolvedValue(user({ id: 'new-admin', role: 'ADMIN' }));

      await service.create({ email: 'a@k.t', name: 'A', password: 'Admin1234!Aa', role: 'ADMIN' });

      expect(membership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'new-admin' });
      expect(membership.setGlobalAdmin).toHaveBeenCalledWith('new-admin', true, { type: 'SYSTEM', id: 'admin-users' });
    });
  });

  describe('update', () => {
    it('refuses to demote or disable yourself', async () => {
      await expect(service.update('u1', 'u1', { disabled: true })).rejects.toBeInstanceOf(ForbiddenAppException);
      await expect(service.update('u1', 'u1', { role: 'MEMBER' })).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(repo.updateUser).not.toHaveBeenCalled();
    });

    it('404s an unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('u1', 'nope', { disabled: true })).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('refuses to remove the last active admin, under the lock', async () => {
      repo.findById.mockResolvedValue(user({ role: 'ADMIN' }));
      repo.countActiveAdmins.mockResolvedValue(1);

      await expect(service.update('u1', 'u2', { role: 'MEMBER' })).rejects.toBeInstanceOf(ConflictAppException);
      expect(repo.lockUserAdministration).toHaveBeenCalled();
      expect(repo.lockUserAdministration.mock.invocationCallOrder[0]).toBeLessThan(repo.countActiveAdmins.mock.invocationCallOrder[0]);
      expect(repo.updateUser).not.toHaveBeenCalled();
      // The refusal must not have touched any binding either.
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
    });

    it('disables an admin when another active admin remains, bumping tokenVersion', async () => {
      repo.findById.mockResolvedValue(user({ role: 'ADMIN' }));
      repo.countActiveAdmins.mockResolvedValue(2);

      await service.update('u1', 'u2', { disabled: true });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: true, bumpTokenVersion: true });
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(cache.invalidate).toHaveBeenCalledWith('USER:u2', { mode: 'tag' });
      // MEMORY-strategy fallback: evict the 60 s auth-state entry directly.
      expect(cache.invalidate).toHaveBeenCalledWith(['user-auth-state', 'u2']);
    });

    it('grants the admin binding through setGlobalAdmin and leaves the role to it', async () => {
      stored = user({ role: 'MEMBER' });

      const updated = await service.update('u1', 'u2', { role: 'ADMIN' });

      expect(membership.setGlobalAdmin).toHaveBeenCalledWith('u2', true, { type: 'USER', id: 'u1' });
      // The role column belongs to setGlobalAdmin's mirror: `update` must not write it itself.
      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: undefined, bumpTokenVersion: false });
      expect(updated.role).toBe('MEMBER');
    });

    it('removes the admin binding through setGlobalAdmin on a demotion', async () => {
      stored = user({ role: 'ADMIN' });
      repo.countActiveAdmins.mockResolvedValue(2);

      await service.update('u1', 'u2', { role: 'MEMBER' });

      expect(membership.setGlobalAdmin).toHaveBeenCalledWith('u2', false, { type: 'USER', id: 'u1' });
      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: undefined, bumpTokenVersion: false });
    });

    it('returns the stored role after a requested demotion of an Owner', async () => {
      // setGlobalAdmin refuses to touch an owner's binding, so `User.role` stays ADMIN.
      stored = user({ role: 'ADMIN' });
      repo.countActiveAdmins.mockResolvedValue(2);

      const updated = await service.update('u1', 'u2', { role: 'MEMBER' });

      expect(updated.role).toBe('ADMIN');
    });

    it('bumps tokenVersion on re-enable, not on a role change', async () => {
      stored = user({ role: 'ADMIN' });
      repo.countActiveAdmins.mockResolvedValue(2);
      await service.update('u1', 'u2', { role: 'MEMBER' });
      expect(repo.updateUser).toHaveBeenLastCalledWith('u2', { disabled: undefined, bumpTokenVersion: false });

      stored = user({ disabled: true });
      await service.update('u1', 'u2', { disabled: false });
      expect(repo.updateUser).toHaveBeenLastCalledWith('u2', { disabled: false, bumpTokenVersion: false });
    });

    it('does not count admins for a MEMBER target', async () => {
      repo.findById.mockResolvedValue(user({ role: 'MEMBER' }));
      await service.update('u1', 'u2', { disabled: true });
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });
  });
});
