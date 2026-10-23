import * as bcrypt from 'bcrypt';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../../generated/prisma/client';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { UserDomain } from '../../auth/domain/auth.domain';
import { hashInviteToken } from './invite-token';
import { InviteAcceptanceService } from './invite-acceptance.service';
import type { ProjectInvitePreview } from './prisma-project-invites.repository';

/**
 * S4b US-005: `InviteAcceptanceService` is constructed with, in order —
 * `(invitesRepo, membersRepo, authService, txManager, membership)`.
 */

const NOW = new Date('2026-10-10T10:00:00Z');
const RAW = 'the-raw-invite-token';
const DAY_MS = 86_400_000;

const inviteRow = (over: Partial<ProjectInvitePreview> = {}): ProjectInvitePreview => ({
  id: 'i1',
  projectId: 'p1',
  email: 'new@x.io',
  role: 'DEVELOPER',
  roleId: 'id-developer',
  roleKey: 'developer',
  roleName: 'Developer',
  status: 'PENDING',
  invitedById: 'admin',
  inviterName: 'Ada',
  acceptedByUserId: null,
  acceptedAt: null,
  expiresAt: new Date(NOW.getTime() + DAY_MS),
  createdAt: NOW,
  projectName: 'Koda',
  projectSlug: 'koda',
  ...over,
});

const userDomain = (over: Partial<UserDomain> = {}): UserDomain => ({
  id: 'u1',
  email: 'new@x.io',
  name: 'New User',
  passwordHash: 'hash',
  tokenVersion: 0,
  disabled: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

interface SetupOptions {
  row?: ProjectInvitePreview | null;
  existingAccount?: boolean;
  claimLost?: boolean;
  createFails?: unknown;
  /** The role the invite persists is deleted before the binding: `createBindingForRole` answers null. */
  roleVanished?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const calls: string[] = [];
  const invites = {
    findByTokenHash: vi.fn(async (_tokenHash: string) =>
      opts.row === undefined ? inviteRow() : opts.row),
    claimPending: vi.fn(async () => {
      calls.push('claim');
      return !opts.claimLost;
    }),
    setAcceptedBy: vi.fn(async (_id: string, _userId: string, _now: Date) => {
      calls.push('setAcceptedBy');
    }),
  };

  const members = {
    findUserIdByEmail: vi.fn(async () => (opts.existingAccount ? 'u-existing' : null)),
    createInvitedUser: vi.fn(async (input: { name: string; passwordHash: string }) => {
      calls.push('createUser');
      if (opts.createFails) throw opts.createFails;
      return userDomain({ name: input.name, passwordHash: input.passwordHash });
    }),
    createMember: vi.fn(async (_projectId: string, userId: string, role: string) => {
      calls.push('createMember');
      return { userId, email: 'new@x.io', name: 'New User', role, disabled: false, joinedAt: NOW };
    }),
  };

  let inTransaction = false;
  const txManager = {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      inTransaction = true;
      try {
        return await fn();
      } finally {
        inTransaction = false;
      }
    },
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => inTransaction),
  };

  const auth = {
    issueSession: vi.fn(async (user: UserDomain) => {
      calls.push('session');
      return { accessToken: 'a', refreshToken: 'r', user: { id: user.id, email: user.email, role: 'MEMBER' } };
    }),
  };

  const membership = {
    afterCommit: vi.fn(fn => fn()),
    createBinding: vi.fn(async () => { calls.push('projectBinding'); }),
    createBindingForRole: vi.fn(async () => {
      if (opts.roleVanished) return null;
      calls.push('projectBinding');
      return { id: 'binding-1' };
    }),
    bindBaseline: vi.fn(async () => { calls.push('baseline'); }),
  };
  const service = new InviteAcceptanceService(
    invites as never,
    members as never,
    auth as never,
    txManager as never,
    membership as never,
  );

  return { service, invites, members, membership, auth, calls, isInTransaction: () => inTransaction };
}

const validBody = { name: 'New User', password: 'StrongPass123!' };

describe('InviteAcceptanceService.preview (S4b US-005)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-1: returns exactly the seven public fields and hashes the token before lookup', async () => {
    const { service, invites } = setup();

    const view = await service.preview(RAW);

    expect(invites.findByTokenHash).toHaveBeenCalledWith(hashInviteToken(RAW));
    expect(Object.keys(view).sort()).toEqual(
      ['projectName', 'projectSlug', 'email', 'roleKey', 'roleName', 'inviterName', 'expiresAt'].sort(),
    );
    expect(view).toMatchObject({
      projectName: 'Koda',
      projectSlug: 'koda',
      email: 'new@x.io',
      roleKey: 'developer',
      roleName: 'Developer',
      inviterName: 'Ada',
    });
  });

  it('US-005: a custom role key shows with a null legacy role', async () => {
    const { service } = setup({ row: inviteRow({ role: null, roleId: 'id-triager', roleKey: 'triager', roleName: 'Triager' }) });

    await expect(service.preview(RAW)).resolves.toMatchObject({ roleKey: 'triager', roleName: 'Triager' });
  });

  it('AC-2: unknown, expired, cancelled and accepted tokens raise the same 404 shape', async () => {
    const cases = [
      await rejection(() => setup({ row: null }).service.preview(RAW)),
      await rejection(() => setup({ row: inviteRow({ expiresAt: new Date(NOW.getTime() - 1) }) }).service.preview(RAW)),
      await rejection(() => setup({ row: inviteRow({ status: 'CANCELLED' }) }).service.preview(RAW)),
      await rejection(() => setup({ row: inviteRow({ status: 'ACCEPTED' }) }).service.preview(RAW)),
    ];

    for (const error of cases) {
      expect(error).toBeInstanceOf(NotFoundAppException);
      expect((error as NotFoundAppException).code).toBe(404);
      expect((error as NotFoundAppException).prefix).toBe('invites');
      expect((error as NotFoundAppException).args).toEqual({});
      expect((error as NotFoundAppException).httpStatus).toBe(404);
    }
  });
});

describe('InviteAcceptanceService.accept (S4b US-005)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-3/AC-4: creates the MEMBER account, the invite-role membership and issues the session after commit', async () => {
    const { service, invites, members, membership, calls } = setup();

    const session = await service.accept(RAW, validBody);

    expect(calls).toEqual(['claim', 'createUser', 'setAcceptedBy', 'projectBinding', 'baseline', 'session']);
    expect(members.findUserIdByEmail).toHaveBeenCalledWith('new@x.io');
    expect(membership.createBindingForRole).toHaveBeenCalledWith(
      { principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleId: 'id-developer' },
      { type: 'SYSTEM', id: 'invite' },
    );
    expect(membership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'u1' });
    expect(members.createMember).not.toHaveBeenCalled();
    expect(invites.setAcceptedBy).toHaveBeenCalledWith('i1', 'u1', NOW);
    expect(session.user).toMatchObject({ id: 'u1', email: 'new@x.io', role: 'MEMBER' });
  });

  it('US-005: binds the role row the invite persisted, by id rather than by its key', async () => {
    const { service, membership } = setup({
      row: inviteRow({ role: null, roleId: 'id-triager', roleKey: 'triager', roleName: 'Triager' }),
    });

    await service.accept(RAW, validBody);

    expect(membership.createBindingForRole).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 'id-triager' }),
      { type: 'SYSTEM', id: 'invite' },
    );
    // The key is only what the invite displays: resolving it here could bind a replacement role.
    expect(membership.createBinding).not.toHaveBeenCalled();
  });

  it('US-005 AC-7: a pre-migration invite without a roleId binds the role its legacy value maps to', async () => {
    const { service, membership } = setup({
      row: inviteRow({ role: 'VIEWER', roleId: null, roleKey: 'viewer', roleName: 'Viewer' }),
    });

    await service.accept(RAW, validBody);

    expect(membership.createBinding).toHaveBeenCalledWith(
      { principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleKey: 'viewer' },
      { type: 'SYSTEM', id: 'invite' },
    );
    expect(membership.createBindingForRole).not.toHaveBeenCalled();
  });

  it('US-005 AC-7: a role deleted between the invite read and the binding is a 409 invites.roleGone without a session', async () => {
    // The invite still carries the deleted role's id: resolving its key would have granted whichever
    // role now owns that key, which is exactly what must not happen.
    const { service, invites, membership, auth } = setup({
      row: inviteRow({ role: null, roleId: 'id-gone', roleKey: 'triager', roleName: 'Triager' }),
      roleVanished: true,
    });

    await expect(service.accept(RAW, validBody)).rejects.toMatchObject({
      prefix: 'invites.roleGone',
      httpStatus: 409,
    });
    expect(membership.createBindingForRole).toHaveBeenCalledTimes(1);
    expect(membership.createBinding).not.toHaveBeenCalled();
    expect(membership.bindBaseline).not.toHaveBeenCalled();
    // The claim was taken inside the same transaction, which rolls it back with the account.
    expect(invites.claimPending).toHaveBeenCalledTimes(1);
    expect(auth.issueSession).not.toHaveBeenCalled();
  });

  it('US-005: an invite with no role at all is a 409 invites.roleGone before the claim, creating nothing', async () => {
    const { service, invites, members, membership } = setup({
      row: inviteRow({ role: null, roleId: null, roleKey: null, roleName: null }),
    });

    await expect(service.accept(RAW, validBody)).rejects.toMatchObject({ prefix: 'invites.roleGone', httpStatus: 409 });
    expect(invites.claimPending).not.toHaveBeenCalled();
    expect(members.createInvitedUser).not.toHaveBeenCalled();
    expect(membership.createBinding).not.toHaveBeenCalled();
    expect(membership.createBindingForRole).not.toHaveBeenCalled();
  });

  it('AC-3: hashes the password with bcrypt at register cost and stores it on the created user', async () => {
    const { service, members } = setup();

    await service.accept(RAW, validBody);

    const created = members.createInvitedUser.mock.calls[0][0] as { passwordHash: string; name: string };
    expect(created.name).toBe('New User');
    expect(created.passwordHash).not.toBe(validBody.password);
    expect(await bcrypt.compare(validBody.password, created.passwordHash)).toBe(true);
  });

  it('AC-6: an expired token claims nothing and issues no session', async () => {
    const { service, invites, members, auth } = setup({ row: inviteRow({ expiresAt: new Date(NOW.getTime() - 1) }) });

    await expect(service.accept(RAW, validBody)).rejects.toBeInstanceOf(NotFoundAppException);
    expect(invites.claimPending).not.toHaveBeenCalled();
    expect(members.createInvitedUser).not.toHaveBeenCalled();
    expect(auth.issueSession).not.toHaveBeenCalled();
  });

  it('AC-7: losing the single-use claim is a 404 and writes nothing', async () => {
    const { service, members, membership, auth } = setup({ claimLost: true });

    await expect(service.accept(RAW, validBody)).rejects.toBeInstanceOf(NotFoundAppException);
    expect(members.createInvitedUser).not.toHaveBeenCalled();
    expect(membership.createBinding).not.toHaveBeenCalled();
    expect(membership.bindBaseline).not.toHaveBeenCalled();
    expect(auth.issueSession).not.toHaveBeenCalled();
  });

  it('AC-9: an account for the invited address is a 409 and the claim rolls back', async () => {
    const { service, members, membership } = setup({ existingAccount: true });

    await expect(service.accept(RAW, validBody)).rejects.toBeInstanceOf(ConflictAppException);
    expect(members.createInvitedUser).not.toHaveBeenCalled();
    expect(membership.createBinding).not.toHaveBeenCalled();
    expect(membership.bindBaseline).not.toHaveBeenCalled();
  });

  it('AC-3: a unique violation on the email is a 409, never a 500', async () => {
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });
    const { service } = setup({ createFails: uniqueViolation });

    await expect(service.accept(RAW, validBody)).rejects.toBeInstanceOf(ConflictAppException);
  });

  it('AC-9: an unexpected repository failure is rethrown, not swallowed', async () => {
    const boom = new Error('connection lost');
    const { service, auth } = setup({ createFails: boom });

    await expect(service.accept(RAW, validBody)).rejects.toBe(boom);
    expect(auth.issueSession).not.toHaveBeenCalled();
  });

  it('AC-5: the session is never issued while the accept transaction is still open', async () => {
    const { service, isInTransaction, auth } = setup();

    await service.accept(RAW, validBody);

    expect(auth.issueSession).toHaveBeenCalledTimes(1);
    expect(isInTransaction()).toBe(false);
  });
});

/** Runs `fn` and returns the rejection error; fails the test when nothing is thrown. */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}
