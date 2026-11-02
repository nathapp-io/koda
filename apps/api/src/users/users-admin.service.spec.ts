import type { Mock } from 'vitest';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../generated/prisma/client';
import { UsersAdminService } from './users-admin.service';
import { AfterCommitService } from '../permissions/after-commit.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { UserAdminRecord } from './domain/user-admin.domain';
import type { PrincipalRef } from '../permissions/permissions.types';
import { OWNER_BINDING_KEY } from '../permissions/catalog';
import * as bcrypt from 'bcrypt';

// The service imports bcrypt as a namespace (`import * as bcrypt`), which `vi.spyOn` on the module
// object cannot intercept — the namespace entries are read-only bindings. A passthrough mock keeps
// every real hash and lets the create's hashing be asserted. The passthrough is an arrow function on
// purpose: bcrypt's `hash` reads the module through its call context, which a mock would otherwise
// replace with the mock itself.
vi.mock('bcrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcrypt')>();
  return {
    ...actual,
    hash: vi.fn((...args: Parameters<typeof actual.hash>) => actual.hash(...args)),
  };
});

const hashCalls = () => vi.mocked(bcrypt.hash);

const user = (over: Partial<UserAdminRecord> = {}): UserAdminRecord => ({
  id: 'u2', email: 'u2@koda.test', name: 'U2', disabled: false,
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('UsersAdminService', () => {
  let repo: Record<string, Mock>;
  let cache: { invalidate: Mock };
  let membership: { bindBaseline: Mock; setGlobalAdmin: Mock; isGlobalAdmin: Mock; afterCommit: Mock; lockOwnerBindings: Mock; invalidatePermissions: Mock };
  let service: UsersAdminService;
  let afterCommit: AfterCommitService;
  let permissionService: { effectiveKeys: Mock };
  let mockAuditRecorder: { record: Mock };
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
      lockOwnerBindings: vi.fn(),
      invalidatePermissions: vi.fn(),
      // B3/B4: the writes run inside `update`'s transaction and `create`'s own one; the stub runs the
      // callback and flushes nothing, exactly as the real service does when it defers nothing.
      afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
    };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    mockAuditRecorder = { record: vi.fn() };
    afterCommit = new AfterCommitService();
    permissionService = { effectiveKeys: vi.fn().mockResolvedValue(new Set<string>()) };
    service = new UsersAdminService(repo as never, txManager as never, cache as never, membership as never, mockAuditRecorder as never, afterCommit, permissionService as never);
  });

  it('AC-16/18: create records only created, never account secrets', async () => {
    repo.createUser.mockResolvedValue(user());
    await service.create({ email: 'secret@k.t', name: 'Secret Name', password: 'Admin1234!Aa' });
    expect(mockAuditRecorder.record).toHaveBeenCalledExactlyOnceWith({ key: 'user.create', resourceType: 'user', resourceId: 'u2', projectId: null, summary: 'created' });
  });
  it('AC-17: update records patch field names only', async () => {
    await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: true });
    expect(mockAuditRecorder.record).toHaveBeenCalledExactlyOnceWith({ key: 'user.update', resourceType: 'user', resourceId: 'u2', projectId: null, summary: 'fields: disabled' });
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
     * member — the only binding is the baseline. A global admin is a
     * `POST /role-bindings` grant afterwards, so `create` never promotes.
     */
    it('AC-1 and AC-2: writes no role, binds the member baseline and grants no admin binding', async () => {
      repo.createUser.mockResolvedValue(user({ id: 'new-member' }));

      const created = await service.create({ email: 'm@k.t', name: 'M', password: 'Admin1234!Aa' });

      expect(repo.createUser.mock.calls[0][0]).not.toHaveProperty('role');
      expect(membership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'new-member' });
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(created).not.toHaveProperty('role');
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

  /**
   * US-007: the gated create has to hash outside the execution transaction, so the work is split into
   * a preparation (read + bcrypt) and the mutation callback the engine runs inside its transaction.
   */
  describe('prepareCreate', () => {
    // A block body: `mockClear()` answers the mock (a function), which `beforeEach` would otherwise
    // register as a teardown and call with no arguments.
    beforeEach(() => { hashCalls().mockClear(); });

    it('AC-8: refuses a taken email with 409 users and never pays for bcrypt', async () => {
      repo.findByEmail.mockResolvedValue({ id: 'existing' });

      const failure = await service
        .prepareCreate({ email: 'Taken@K.T', name: 'Taken', password: 'Admin1234!Aa' })
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictAppException);
      expect((failure as ConflictAppException).prefix).toBe('users');
      // The canonical form is what the repository is asked about, as `create` does.
      expect(repo.findByEmail).toHaveBeenCalledWith('taken@k.t');
      expect(hashCalls()).not.toHaveBeenCalled();
    });

    it('AC-9: hashes at cost 12 before any write and its callback writes that hash', async () => {
      const mutate = await service.prepareCreate({ email: ' Late@K.T ', name: 'Late', password: 'Admin1234!Aa' });

      expect(hashCalls()).toHaveBeenCalledExactlyOnceWith('Admin1234!Aa', 12);
      expect(repo.createUser).not.toHaveBeenCalled();

      repo.createUser.mockResolvedValue(user({ email: 'late@k.t' }));
      const created = await mutate();

      const hash = await hashCalls().mock.results[0].value;
      expect(repo.createUser).toHaveBeenCalledExactlyOnceWith({
        email: 'late@k.t', name: 'Late', passwordHash: hash,
      });
      expect(hash).not.toBe('Admin1234!Aa');
      expect(bcrypt.getRounds(hash)).toBe(12);
      // The hash is ready before the write starts: bcrypt never runs inside the execution transaction.
      expect(hashCalls().mock.invocationCallOrder[0])
        .toBeLessThan(repo.createUser.mock.invocationCallOrder[0]);
      expect(created.email).toBe('late@k.t');
    });
  });

  describe('update', () => {
    it('AC-1/2: a non-Owner cannot disable an Owner and no update is written', async () => {
      stored = user({ id: 'owner-1' });
      permissionService.effectiveKeys.mockImplementation(async (principal: PrincipalRef) =>
        principal.id === 'owner-1' ? new Set([OWNER_BINDING_KEY]) : new Set(),
      );
      const actor: PrincipalRef = { type: 'USER', id: 'admin-1' };
      const error = await service.update(actor, 'owner-1', { disabled: true }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).prefix).toBe('users.owner');
      expect(membership.lockOwnerBindings.mock.invocationCallOrder[0]).toBeLessThan(permissionService.effectiveKeys.mock.invocationCallOrder[0]);
      expect(membership.invalidatePermissions.mock.invocationCallOrder[0]).toBeLessThan(permissionService.effectiveKeys.mock.invocationCallOrder[0]);
      expect(repo.updateUser).not.toHaveBeenCalled();
    });

    it('AC-3: an agent without Owner permission cannot disable an Owner', async () => {
      stored = user({ id: 'owner-1' });
      permissionService.effectiveKeys.mockImplementation(async (principal: PrincipalRef) =>
        principal.id === 'owner-1' ? new Set([OWNER_BINDING_KEY]) : new Set(),
      );
      await expect(service.update({ type: 'AGENT', id: 'agent-1' }, 'owner-1', { disabled: true }))
        .rejects.toMatchObject({ prefix: 'users.owner' });
      expect(repo.updateUser).not.toHaveBeenCalled();
    });

    it('AC-4: an Owner can disable another Owner', async () => {
      stored = user({ id: 'owner-1' });
      permissionService.effectiveKeys.mockResolvedValue(new Set([OWNER_BINDING_KEY]));
      await service.update({ type: 'USER', id: 'owner-2' }, 'owner-1', { disabled: true });
      expect(repo.updateUser).toHaveBeenCalledWith('owner-1', { disabled: true, bumpTokenVersion: true });
    });

    it('AC-5/6: admins can disable non-Owners and re-enable an Owner', async () => {
      stored = user({ id: 'member-1' });
      await service.update({ type: 'USER', id: 'admin-1' }, 'member-1', { disabled: true });
      expect(repo.updateUser).toHaveBeenCalledWith('member-1', { disabled: true, bumpTokenVersion: true });
      repo.updateUser.mockClear();
      stored = user({ id: 'owner-1' });
      await service.update({ type: 'USER', id: 'admin-1' }, 'owner-1', { disabled: false });
      expect(repo.updateUser).toHaveBeenCalledWith('owner-1', { disabled: false, bumpTokenVersion: false });
    });

    it('AC-7: self-disable remains refused before the target lookup', async () => {
      const failure = await service.update({ type: 'USER', id: 'owner-1' }, 'owner-1', { disabled: true })
        .catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(ForbiddenAppException);
      expect((failure as ForbiddenAppException).prefix).toBe('users.self');
      expect(repo.findById).not.toHaveBeenCalled();
    });
    it('AC-11: defers both auth cache evictions until the outer scope returns', async () => {
      await afterCommit.scope(async () => {
        await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: true });
        expect(repo.updateUser).toHaveBeenCalled();
        expect(cache.invalidate).not.toHaveBeenCalled();
      });
      expect(cache.invalidate).toHaveBeenCalledTimes(2);
      expect(cache.invalidate).toHaveBeenCalledWith('USER:u2', { mode: 'tag' });
      expect(cache.invalidate).toHaveBeenCalledWith(['user-auth-state', 'u2']);
    });
    it('drops auth cache evictions when the outer transaction rolls back', async () => {
      await expect(afterCommit.scope(async () => {
        await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: true });
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(cache.invalidate).not.toHaveBeenCalled();
    });
    /**
     * US-005: `disabled` is the only patchable field, so a self-disable is the only self-patch the
     * rule refuses. A patch that asks for a role changes nothing, so it is not a refusal.
     */
    it('refuses a self-disable and accepts every other self-patch', async () => {
      await expect(service.update({ type: 'USER', id: 'u1' }, 'u1', { disabled: true })).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(repo.updateUser).not.toHaveBeenCalled();

      await expect(service.update({ type: 'USER', id: 'u1' }, 'u1', { disabled: false })).resolves.toBeDefined();
      expect(repo.updateUser).toHaveBeenCalledWith('u1', { disabled: false, bumpTokenVersion: false });
    });

    it('404s an unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update({ type: 'USER', id: 'u1' }, 'nope', { disabled: true })).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('refuses to disable the last active admin, under the lock', async () => {
      stored = user();
      membership.isGlobalAdmin.mockResolvedValue(true);
      repo.countActiveAdmins.mockResolvedValue(1);

      await expect(service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: true })).rejects.toBeInstanceOf(ConflictAppException);
      expect(repo.lockUserAdministration).toHaveBeenCalled();
      expect(repo.lockUserAdministration.mock.invocationCallOrder[0]).toBeLessThan(repo.countActiveAdmins.mock.invocationCallOrder[0]);
      expect(repo.updateUser).not.toHaveBeenCalled();
      // The refusal must not have touched any binding either.
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
    });

    it('disables an admin when another active admin remains, bumping tokenVersion', async () => {
      stored = user();
      membership.isGlobalAdmin.mockResolvedValue(true);
      repo.countActiveAdmins.mockResolvedValue(2);

      await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: true });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: true, bumpTokenVersion: true });
      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(cache.invalidate).toHaveBeenCalledWith('USER:u2', { mode: 'tag' });
      // MEMORY-strategy fallback: evict the 60 s auth-state entry directly.
      expect(cache.invalidate).toHaveBeenCalledWith(['user-auth-state', 'u2']);
    });

    it('re-enables a disabled user without bumping tokenVersion again', async () => {
      stored = user({ disabled: true });

      await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: false });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: false, bumpTokenVersion: false });
      expect(membership.isGlobalAdmin).not.toHaveBeenCalled();
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });

    /**
     * US-005: `update` never calls `setGlobalAdmin`, so no patch can promote or demote. The row it
     * returns is what it read back; privilege is always binding-derived.
     */
    it('never touches a binding, whatever the stored row says', async () => {
      stored = user();
      membership.isGlobalAdmin.mockResolvedValue(true);
      repo.countActiveAdmins.mockResolvedValue(2);

      const updated = await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: false });

      expect(membership.setGlobalAdmin).not.toHaveBeenCalled();
      expect(repo.updateUser).toHaveBeenCalledWith('u2', { disabled: false, bumpTokenVersion: false });
      expect(updated).not.toHaveProperty('role');
    });

    it('does not count admins when isGlobalAdmin is false', async () => {
      stored = user();
      membership.isGlobalAdmin.mockResolvedValue(false);
      await service.update({ type: 'USER', id: 'u1' }, 'u2', { disabled: true });
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });
  });
});
