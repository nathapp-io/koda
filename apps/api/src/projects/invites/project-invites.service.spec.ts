import type { AuditEntriesOf } from '../../audit/audit-recorder.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { legacyRoleForRoleKey } from '../../permissions/legacy-project-roles';
import { hashInviteToken } from './invite-token';
import { ProjectInvitesService } from './project-invites.service';
import type { ProjectInviteRecord } from './domain/project-invite.domain';

/**
 * S4b US-004: `ProjectInvitesService` is constructed with, in order —
 * `(invitesRepo, membersRepo, access, mailer, emailSchedule, emailAvailability, txManager, membership, roles, audit)`.
 */

const NOW = new Date('2026-10-10T10:00:00Z');
const plusDays = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);
const rawOf = (invitePath?: string): string => (invitePath ?? '').split('/').pop() ?? '';

const admin = { actorType: 'user', id: 'admin', role: 'MEMBER', email: 'admin@k.t' } as KodaPrincipal;

/** The `RoleAdminService.assertMayGrant` double answers a role whose id is `id-<key>`. */
const ROLE_KEY_BY_ID: Record<string, string> = {
  'id-project-admin': 'project-admin',
  'id-developer': 'developer',
  'id-viewer': 'viewer',
  'id-triager': 'triager',
};

interface SetupOptions {
  existingUser?: { id: string; disabled: boolean } | null;
  memberExists?: boolean;
  configured?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const store: ProjectInviteRecord[] = [];

  const invites = {
    cancelPending: vi.fn(async (projectId: string, email: string) => {
      let count = 0;
      for (const row of store) {
        if (row.projectId === projectId && row.email === email && row.status === 'PENDING') {
          row.status = 'CANCELLED';
          count += 1;
        }
      }
      return count;
    }),
    create: vi.fn(async (input: {
      projectId: string; email: string; roleId: string;
      tokenHash: string; invitedById: string | null; invitedByAgentId: string | null; expiresAt: Date;
    }): Promise<ProjectInviteRecord> => {
      const record: ProjectInviteRecord = {
        id: `i${store.length + 1}`,
        projectId: input.projectId,
        email: input.email,
        roleId: input.roleId,
        roleKey: ROLE_KEY_BY_ID[input.roleId] ?? null,
        roleName: ROLE_KEY_BY_ID[input.roleId] ? `Name of ${ROLE_KEY_BY_ID[input.roleId]}` : null,
        status: 'PENDING',
        invitedById: input.invitedById,
        inviterName: input.invitedByAgentId ? 'roster-agent' : 'Ada',
        acceptedByUserId: null,
        acceptedAt: null,
        expiresAt: input.expiresAt,
        createdAt: NOW,
      };
      store.push(record);
      return record;
    }),
    list: vi.fn(async () => [...store]),
    findById: vi.fn(),
    // US-008: resend and cancel read the pending invite through the project-scoped lookup.
    findByIdForProject: vi.fn(),
    rotate: vi.fn(),
    cancel: vi.fn(),
  };

  const members = {
    findUserIdByEmail: vi.fn(async () => (opts.existingUser ? opts.existingUser.id : null)),
    findUserState: vi.fn(async () =>
      opts.existingUser ? { id: opts.existingUser.id, email: 'b@x.io', name: 'New User', disabled: opts.existingUser.disabled } : null),
    lockMembers: vi.fn(),
    findLocalRole: vi.fn(async () => opts.memberExists ? 'VIEWER' : null),
    /**
     * US-003: an `ADDED` outcome reads the written membership back (the same `readMemberRecord` the
     * members routes use), so this double answers the record the binding write produced.
     */
    findRequiredMember: vi.fn(async (_projectId: string, userId: string) => {
      const writes = membership.createBinding.mock.calls as unknown as Array<[{ roleKey: string }]>;
      const roleKey = writes[writes.length - 1]?.[0]?.roleKey ?? 'viewer';
      return {
        userId,
        email: 'b@x.io',
        name: 'New User',
        role: legacyRoleForRoleKey(roleKey),
        disabled: false,
        joinedAt: NOW,
        principalType: 'USER',
        principalId: userId,
        agentSlug: null,
        bindings: [{ id: 'binding-1', roleKey, roleName: roleKey }],
      };
    }),
  };

  const access = {
    findProjectIdBySlug: vi.fn(async () => 'p1'),
  };

  const mailer = { sendInvite: vi.fn(async (_input: unknown) => true) };
  const schedule = { scheduleMemberAdded: vi.fn(async () => undefined) };
  const email = { configured: opts.configured ?? true, config: () => ({ inviteTtlDays: 7 }) };
  let inTransaction = false;
  const txManager = {
    run: async <T>(fn: () => Promise<T>) => {
      const previous = inTransaction;
      inTransaction = true;
      try { return await fn(); } finally { inTransaction = previous; }
    },
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => inTransaction),
  };

  const membership = {
    afterCommit: vi.fn(fn => fn()),
    createBinding: vi.fn(async () => ({ id: 'binding-1', createdAt: NOW })),
  };
  const roles = {
    assertMayGrant: vi.fn(async (_principal: unknown, target: { roleKey: string }) => ({
      id: `id-${target.roleKey}`,
      key: target.roleKey,
      name: `Name of ${target.roleKey}`,
    })),
  };
  const entriesOfCalled = vi.fn();
  const mockAuditRecorder = {
    record: vi.fn(async (_input: unknown) => { expect(inTransaction).toBe(true); }),
    audited: vi.fn(async <T>(fn: () => Promise<T>, entriesOf: AuditEntriesOf<T>) => {
      const result = await fn();
      entriesOfCalled(entriesOf(result));
      return result;
    }),
  };
  const service = new ProjectInvitesService(
    invites as never,
    members as never,
    access as never,
    mailer as never,
    schedule as never,
    email as never,
    txManager as never,
    membership as never,
    roles as never,
    mockAuditRecorder as never,
  );

  const seed = (over: Partial<ProjectInviteRecord> = {}) => {
    const record: ProjectInviteRecord = {
      id: 'i-seed',
      projectId: 'p1',
      email: 'new@x.io',
      roleId: 'id-developer',
      roleKey: 'developer',
      roleName: 'Developer',
      status: 'PENDING',
      invitedById: 'admin',
      inviterName: 'Ada',
      acceptedByUserId: null,
      acceptedAt: null,
      expiresAt: plusDays(NOW, 7),
      createdAt: NOW,
      ...over,
    };
    store.push(record);
    return record;
  };

  return { service, audit: mockAuditRecorder, entriesOfCalled, invites, membership, members, access, roles, mailer, schedule, email, store, seed };
}

describe('ProjectInvitesService.create (S4b US-004)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('P1m AC-10/11: developer invite stores only roleId and mails its display name', async () => {
    const { service, invites, mailer, roles } = setup();
    roles.assertMayGrant.mockResolvedValueOnce({ id: 'id-developer', key: 'developer', name: 'Developer' });
    // The persisted role name, not a legacy enum, supplies the email display text.
    invites.create.mockImplementationOnce(async () => ({
      id: 'i1', projectId: 'p1', email: 'new@x.io', roleId: 'id-developer',
      roleKey: 'developer', roleName: 'Developer', status: 'PENDING', invitedById: 'admin',
      inviterName: 'Ada', acceptedByUserId: null, acceptedAt: null, expiresAt: plusDays(NOW, 7), createdAt: NOW,
    }));
    await service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en');
    expect(invites.create.mock.calls[0][0]).toMatchObject({ roleId: 'id-developer' });
    expect(invites.create.mock.calls[0][0]).not.toHaveProperty('role');
    expect(mailer.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ role: 'Developer' }));
  });

  it('P1m AC-12: a missing role name mails an empty display role', async () => {
    const { service, invites, mailer, seed } = setup();
    const record = seed({ roleName: null });
    invites.findByIdForProject.mockResolvedValue(record);
    invites.rotate.mockResolvedValue(record);
    await service.resend('p', record.id, admin, 'en');
    expect(mailer.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ role: '' }));
  });

  it('US-008 AC-2: create no longer consults a legacy admin gate — the route key refuses non-admins', async () => {
    const { service, invites, membership, access } = setup({ existingUser: null });

    const result = await service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en');

    expect(access.findProjectIdBySlug).toHaveBeenCalledWith('p');
    expect(result.outcome).toBe('INVITED');
    expect(invites.create).toHaveBeenCalled();
    expect(membership.createBinding).not.toHaveBeenCalled();
  });

  it('AC-3: normalises the email and adds an existing active user as DEVELOPER', async () => {
    const { service, members, membership } = setup({ existingUser: { id: 'u9', disabled: false } });

    const result = await service.create('p', { email: ' New@X.io ', roleKey: 'developer' }, admin, 'en');

    expect(members.findUserIdByEmail).toHaveBeenCalledWith('new@x.io');
    expect(result.outcome).toBe('ADDED');
    // Permissions P1l US-006: the ADDED member answers its bindings, not a display role.
    expect(result.member).not.toHaveProperty('role');
    expect(membership.createBinding).toHaveBeenCalledWith({ principal: { type: 'USER', id: 'u9' }, projectId: 'p1', roleKey: 'developer' }, { type: 'USER', id: 'admin' });
    expect(result.member).toMatchObject({ email: 'b@x.io', name: 'New User', joinedAt: NOW });
    expect(members.lockMembers.mock.invocationCallOrder[0]).toBeLessThan(members.findLocalRole.mock.invocationCallOrder[0]);
  });

  it('US-003: the ADDED outcome carries the written membership bindings, read back through the repository', async () => {
    const { service, members } = setup({ existingUser: { id: 'u9', disabled: false } });

    const result = await service.create('p', { email: 'b@x.io', roleKey: 'developer' }, admin, 'en');

    expect(members.findRequiredMember).toHaveBeenCalledWith('p1', 'u9');
    expect(result.member).toMatchObject({
      principalType: 'USER',
      principalId: 'u9',
      agentSlug: null,
      bindings: [{ id: 'binding-1', roleKey: 'developer', roleName: 'developer' }],
    });
  });

  it('AC-13: adding an existing active user schedules exactly one MEMBER_ADDED and no INVITE', async () => {
    const { service, schedule, mailer } = setup({ existingUser: { id: 'u9', disabled: false } });

    await service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en');

    expect(schedule.scheduleMemberAdded).toHaveBeenCalledTimes(1);
    expect(schedule.scheduleMemberAdded).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u9', projectId: 'p1', toEmail: 'b@x.io' }),
    );
    expect(mailer.sendInvite).not.toHaveBeenCalled();
  });

  it('AC-4: an address that is already a project member is a 409 conflict', async () => {
    const { service, members, membership } = setup({ existingUser: { id: 'u9', disabled: false }, memberExists: true });

    await expect(service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en'))
      .rejects.toBeInstanceOf(ConflictAppException);
    await expect(service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en'))
      .rejects.toMatchObject({ prefix: 'invites.memberExists', httpStatus: 409 });
    expect(members.findLocalRole).toHaveBeenCalledWith('p1', 'u9');
    expect(membership.createBinding).not.toHaveBeenCalled();
  });

  it('AC-5: a disabled account is a 409 conflict and writes nothing else', async () => {
    const { service, invites, membership } = setup({ existingUser: { id: 'u9', disabled: true } });

    await expect(service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en'))
      .rejects.toBeInstanceOf(ConflictAppException);
    expect(membership.createBinding).not.toHaveBeenCalled();
    expect(invites.create).not.toHaveBeenCalled();
  });

  it('AC-6: a new address stores only the hash of the returned raw token', async () => {
    const { service, invites } = setup({ existingUser: null });

    const result = await service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en');

    expect(result.outcome).toBe('INVITED');
    const raw = rawOf(result.invitePath);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invites.cancelPending).toHaveBeenCalledWith('p1', 'new@x.io');
    const stored = invites.create.mock.calls[0][0];
    expect(stored.tokenHash).toBe(hashInviteToken(raw));
    expect(stored.tokenHash).not.toBe(raw);
    expect(JSON.stringify(result.invite)).not.toContain(raw);
  });

  // Whole-branch fix B4: `invite.create` reaches a project-admin agent, so the inviter is stored per
  // actor type. Writing the agent id into the `User`-keyed `invitedById` failed with a P2003.
  it('B4: an agent inviter is stored in invitedByAgentId, and the user column stays null', async () => {
    const { service, invites } = setup({ existingUser: null });
    const agent = { actorType: 'agent', id: 'agent-1', slug: 'roster-agent' } as KodaPrincipal;

    const result = await service.create('p', { email: 'new@x.io', roleKey: 'viewer' }, agent, 'en');

    expect(result.outcome).toBe('INVITED');
    expect(invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ invitedById: null, invitedByAgentId: 'agent-1' }),
    );
    expect(result.invite).toMatchObject({ inviterName: 'roster-agent' });
  });

  it('B4: a user inviter keeps invitedByAgentId null', async () => {
    const { service, invites } = setup({ existingUser: null });

    await service.create('p', { email: 'new@x.io', roleKey: 'viewer' }, admin, 'en');

    expect(invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ invitedById: 'admin', invitedByAgentId: null }),
    );
  });

  it('B4: an agent that adds an existing user records an AGENT granter, not a USER one', async () => {
    const { service, membership } = setup({ existingUser: { id: 'u9', disabled: false } });
    const agent = { actorType: 'agent', id: 'agent-1', slug: 'roster-agent' } as KodaPrincipal;

    await service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, agent, 'en');

    expect(membership.createBinding).toHaveBeenCalledWith(
      expect.objectContaining({ principal: { type: 'USER', id: 'u9' } }),
      { type: 'AGENT', id: 'agent-1' },
    );
  });

  it('AC-7: creating a second invite for the same project and email cancels the earlier one', async () => {
    const { service, store } = setup({ existingUser: null });

    await service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en');
    await service.create('p', { email: ' New@X.io ', roleKey: 'developer' }, admin, 'en');

    expect(store).toHaveLength(2);
    expect(store[0].status).toBe('CANCELLED');
    expect(store[1].status).toBe('PENDING');
  });

  it('AC-10: a configured invite mails the raw link once and reports emailed true', async () => {
    const { service, mailer } = setup({ existingUser: null });

    const result = await service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en');

    expect(result.emailed).toBe(true);
    expect(mailer.sendInvite).toHaveBeenCalledTimes(1);
    const call = mailer.sendInvite.mock.calls[0][0] as { rawToken: string; role: string; toEmail: string };
    expect(call.rawToken).toBe(rawOf(result.invitePath));
    expect(call.role).toBe('Name of developer');
    expect(call.toEmail).toBe('new@x.io');
  });

  it('AC-11: a delivery that throws is reported as emailed false, never an error', async () => {
    const { service, mailer } = setup({ existingUser: null });
    mailer.sendInvite.mockRejectedValueOnce(new Error('SMTP down'));

    await expect(service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en'))
      .resolves.toMatchObject({ outcome: 'INVITED', emailed: false });
  });

  it('AC-12: without email configured no invite mail is attempted and emailed is false', async () => {
    const { service, mailer } = setup({ existingUser: null, configured: false });

    const result = await service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en');

    expect(result.outcome).toBe('INVITED');
    expect(result.emailed).toBe(false);
    expect(mailer.sendInvite).not.toHaveBeenCalled();
  });

  it('AC-12: without email configured an existing user is added without a MEMBER_ADDED email', async () => {
    const { service, schedule, mailer } = setup({ existingUser: { id: 'u9', disabled: false }, configured: false });

    const result = await service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en');

    expect(result.member?.userId).toBe('u9');
    expect(schedule.scheduleMemberAdded).not.toHaveBeenCalled();
    expect(mailer.sendInvite).not.toHaveBeenCalled();
  });
});

describe('ProjectInvitesService.create role keys (permissions P1 web US-005)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks assertMayGrant for the roleKey with a null principal id for a new address, and stores roleId only', async () => {
    const { service, invites, roles } = setup({ existingUser: null });

    await service.create('p', { email: 'new@x.io', roleKey: 'triager' }, admin, 'en');

    expect(roles.assertMayGrant).toHaveBeenCalledWith(admin, {
      roleKey: 'triager',
      projectId: 'p1',
      principalType: 'USER',
      principalId: null,
    });
    expect(invites.create).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'id-triager' }));
  });

  it('US-004 (P1l): a legacy role beside the key is ignored — the key names the granted role', async () => {
    const { service, invites, roles } = setup({ existingUser: null });

    await service.create('p', { email: 'new@x.io', roleKey: 'project-admin', role: 'VIEWER' } as never, admin, 'en');

    expect(roles.assertMayGrant).toHaveBeenCalledWith(admin, expect.objectContaining({ roleKey: 'project-admin' }));
    expect(invites.create).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'id-project-admin' }));
  });

  it('stores only roleId for a built-in role key', async () => {
    const { service, invites } = setup({ existingUser: null });

    await service.create('p', { email: 'new@x.io', roleKey: 'viewer' }, admin, 'en');

    expect(invites.create).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'id-viewer' }));
  });

  it('asks assertMayGrant with the existing user id and binds the granted role key', async () => {
    const { service, roles, membership } = setup({ existingUser: { id: 'u9', disabled: false } });

    await service.create('p', { email: 'b@x.io', roleKey: 'verifier' }, admin, 'en');

    expect(roles.assertMayGrant).toHaveBeenCalledWith(admin, expect.objectContaining({ principalId: 'u9' }));
    expect(membership.createBinding).toHaveBeenCalledWith(
      expect.objectContaining({ roleKey: 'verifier' }),
      { type: 'USER', id: 'admin' },
    );
  });

  it('US-004 (P1l): refuses a request without roleKey before any lookup; a legacy role does not count', async () => {
    const { service, members, roles } = setup({ existingUser: null });

    await expect(service.create('p', { email: 'a@x.io' }, admin, 'en'))
      .rejects.toMatchObject({ prefix: 'invites.roleRequired' });
    // `role` is stripped by the pipe, so a body that only carries it is the same as a body with neither.
    await expect(service.create('p', { email: 'a@x.io', role: 'VIEWER' } as never, admin, 'en'))
      .rejects.toMatchObject({ prefix: 'invites.roleRequired' });
    expect(members.findUserIdByEmail).not.toHaveBeenCalled();
    expect(roles.assertMayGrant).not.toHaveBeenCalled();
  });

  it('runs the disabled-account 409 before the grant rules, and the grant rules before the member 409', async () => {
    const disabled = setup({ existingUser: { id: 'u9', disabled: true } });
    await expect(disabled.service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en'))
      .rejects.toMatchObject({ prefix: 'invites.userDisabled' });
    expect(disabled.roles.assertMayGrant).not.toHaveBeenCalled();

    const member = setup({ existingUser: { id: 'u9', disabled: false }, memberExists: true });
    member.roles.assertMayGrant.mockRejectedValueOnce(new Error('escalation'));
    await expect(member.service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en'))
      .rejects.toThrow('escalation');
    expect(member.members.findLocalRole).not.toHaveBeenCalled();
  });

  it('writes no invite when the grant rules refuse', async () => {
    const { service, invites, roles } = setup({ existingUser: null });
    roles.assertMayGrant.mockRejectedValueOnce(new Error('escalation'));

    await expect(service.create('p', { email: 'new@x.io', roleKey: 'developer' }, admin, 'en')).rejects.toThrow('escalation');
    expect(invites.cancelPending).not.toHaveBeenCalled();
    expect(invites.create).not.toHaveBeenCalled();
  });
});

describe('ProjectInvitesService.list (S4b US-004)', () => {
  // `list` reads the effective status against the current time; the seeded `expiresAt`/`createdAt`
  // are anchored to `NOW`, so the clock must match the same instant the `create` block pins.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-8: an invite DTO exposes exactly the public fields and no token material', async () => {
    const { service, seed } = setup({ existingUser: null });
    seed({ id: 'i1', email: 'new@x.io', status: 'PENDING' });

    const rows = await service.list('p', admin);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'email', 'expiresAt', 'id', 'inviterName', 'roleKey', 'roleName', 'status']);
    expect(JSON.stringify(rows)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('AC-9: an overdue PENDING invite is reported as EXPIRED', async () => {
    const { service, seed } = setup({ existingUser: null });
    seed({ id: 'i1', status: 'PENDING', expiresAt: new Date(NOW.getTime() - 1) });

    const rows = await service.list('p', admin);

    expect(rows.map((row) => row.status)).toEqual(['EXPIRED']);
  });
});

describe('ProjectInvitesService legacy admin gate removal (US-008)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('list, resend and cancel read the project and act without asking a legacy admin gate', async () => {
    const { service, invites, access, seed } = setup({ existingUser: null });
    const invite = seed({ id: 'i1', status: 'PENDING', expiresAt: plusDays(NOW, 7) });
    invites.findByIdForProject.mockResolvedValue(invite);
    invites.rotate.mockResolvedValue(invite);
    invites.cancel.mockResolvedValue(true);

    await expect(service.list('p', admin)).resolves.toHaveLength(1);
    await expect(service.resend('p', 'i1', admin, 'en')).resolves.toHaveProperty('invitePath');
    await expect(service.cancel('p', 'i1', admin)).resolves.toBeUndefined();

    expect(access.findProjectIdBySlug).toHaveBeenCalledTimes(3);
  });
});

describe('invite audit contract', () => {
  it('AC-2/3: new-address create records only the role key and invite id', async () => {
    const { service, audit } = setup({ configured: false });
    const result = await service.create('p', { email: 'secret@x.io', roleKey: 'viewer' }, admin, 'en');
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'invite.create', resourceType: 'project-invite', resourceId: result.invite?.id, projectId: 'p1', summary: 'viewer invited' });
  });
  it('AC-4: existing-user create records only the action, against the binding id', async () => {
    const { service, audit } = setup({ existingUser: { id: 'u9', disabled: false }, configured: false });
    await service.create('p', { email: 'b@x.io', roleKey: 'viewer' }, admin, 'en');
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'invite.create', resourceType: 'role-binding', resourceId: 'binding-1', projectId: 'p1', summary: 'viewer to USER u9' });
  });
  it.each(['resend', 'cancel'] as const)('AC-7/8: %s loses its write race inside audited, never evaluating entriesOf', async method => {
    const { service, invites, audit, seed, entriesOfCalled } = setup({ configured: false });
    invites.findByIdForProject.mockResolvedValue(seed());
    invites.rotate.mockResolvedValue(null);
    invites.cancel.mockResolvedValue(false);
    await expect(method === 'resend' ? service.resend('p', 'i-seed', admin, 'en') : service.cancel('p', 'i-seed', admin)).rejects.toMatchObject({ httpStatus: 409 });
    expect(audit.audited).toHaveBeenCalledTimes(1);
    expect(entriesOfCalled).not.toHaveBeenCalled();
  });
  it.each(['resend', 'cancel'] as const)('AC-5/6: %s emits the invite entry after a successful write', async method => {
    const { service, invites, seed, entriesOfCalled } = setup({ configured: false });
    const row = seed();
    invites.findByIdForProject.mockResolvedValue(row);
    invites.rotate.mockResolvedValue(row);
    invites.cancel.mockResolvedValue(true);
    if (method === 'resend') await service.resend('p', row.id, admin, 'en');
    else await service.cancel('p', row.id, admin);
    expect(entriesOfCalled).toHaveBeenCalledExactlyOnceWith({ key: `invite.${method}`, resourceType: 'project-invite', resourceId: row.id, projectId: 'p1', summary: method === 'resend' ? 'resent' : 'cancelled' });
  });
});
