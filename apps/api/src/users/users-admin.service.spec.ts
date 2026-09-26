import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { UsersAdminService } from './users-admin.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { UserAdminRecord } from './domain/user-admin.domain';

const user = (over: Partial<UserAdminRecord> = {}): UserAdminRecord => ({
  id: 'u2', email: 'u2@koda.test', name: 'U2', role: 'MEMBER', disabled: false,
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('UsersAdminService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: { invalidate: jest.Mock };
  let service: UsersAdminService;

  beforeEach(() => {
    repo = {
      findUserPage: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      createUser: jest.fn(),
      countActiveAdmins: jest.fn(),
      updateUser: jest.fn(async (id: string, w: { role?: string; disabled?: boolean }) => user({ id, ...w })),
      lockUserAdministration: jest.fn(),
    };
    cache = { invalidate: jest.fn() };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    service = new UsersAdminService(repo as never, txManager as never, cache as never);
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
    });

    it('disables an admin when another active admin remains, bumping tokenVersion', async () => {
      repo.findById.mockResolvedValue(user({ role: 'ADMIN' }));
      repo.countActiveAdmins.mockResolvedValue(2);

      await service.update('u1', 'u2', { disabled: true });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { role: undefined, disabled: true, bumpTokenVersion: true });
      expect(cache.invalidate).toHaveBeenCalledWith('USER:u2', { mode: 'tag' });
      // MEMORY-strategy fallback: evict the 60 s auth-state entry directly.
      expect(cache.invalidate).toHaveBeenCalledWith(['user-auth-state', 'u2']);
    });

    it('bumps tokenVersion on a role change, not on re-enable', async () => {
      repo.findById.mockResolvedValueOnce(user({ role: 'MEMBER' }));
      await service.update('u1', 'u2', { role: 'ADMIN' });
      expect(repo.updateUser).toHaveBeenLastCalledWith('u2', expect.objectContaining({ bumpTokenVersion: true }));

      repo.findById.mockResolvedValueOnce(user({ disabled: true }));
      await service.update('u1', 'u2', { disabled: false });
      expect(repo.updateUser).toHaveBeenLastCalledWith('u2', expect.objectContaining({ bumpTokenVersion: false }));
    });

    it('does not count admins for a MEMBER target', async () => {
      repo.findById.mockResolvedValue(user({ role: 'MEMBER' }));
      await service.update('u1', 'u2', { disabled: true });
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });
  });
});
