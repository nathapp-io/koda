import type { Mock } from 'vitest';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ProjectMembersService } from './project-members.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';

const globalAdmin = { actorType: 'user', id: 'g1', role: 'ADMIN', email: 'g@k.t' } as KodaPrincipal;
const projectAdmin = { actorType: 'user', id: 'pa', role: 'MEMBER', email: 'pa@k.t' } as KodaPrincipal;
const member = (userId: string, role: string, disabled = false) =>
  ({
    userId,
    email: `${userId}@k.t`,
    name: userId,
    role,
    disabled,
    joinedAt: new Date(0),
    principalType: 'USER' as const,
    principalId: userId,
    agentSlug: null,
    bindings: [{ id: `bind-${userId}`, roleKey: 'developer', roleName: 'Developer' }],
  });

describe('ProjectMembersService', () => {
  let repo: Record<string, Mock>;
  let access: Record<string, Mock>;
  let service: ProjectMembersService;
  let membership: Record<string, Mock>;
  let permissions: Record<string, Mock>;
  let roles: { assertMayGrant: Mock };

  beforeEach(() => {
    repo = {
      findMemberPage: vi.fn(),
      findMember: vi.fn(),
      findUserByEmail: vi.fn(),
      findUserIdByEmail: vi.fn(),
      countProjectAdmins: vi.fn(),
      lockMembers: vi.fn(),
    };
    access = {
      findProjectIdBySlug: vi.fn().mockResolvedValue('p1'),
      assertProjectMembership: vi.fn(),
      resolveMembership: vi.fn(),
    };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    membership = {
      afterCommit: vi.fn(fn => fn()),
      createBinding: vi.fn(),
      removeProjectBindings: vi.fn(),
    };
    permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) };
    roles = { assertMayGrant: vi.fn(async (): Promise<{ key: string }> => ({ key: 'viewer' })) };
    service = new ProjectMembersService(
      repo as never,
      access as never,
      txManager as never,
      membership as never,
      permissions as never,
      roles as never,
    );
  });

  it('list resolves membership once for viewerRole and asks member.add for canManage', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue('ADMIN');
    permissions.can.mockResolvedValue({ allowed: true, reason: 'granted' });

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(access.resolveMembership).toHaveBeenCalledTimes(1);
    // US-008: canManage is the member.add key, asked for the project the slug resolved to.
    expect(permissions.can).toHaveBeenCalledWith(projectAdmin, 'member.add', { projectId: 'p1' });
    expect(result.canManage).toBe(true);
    expect(result.viewerRole).toBe('ADMIN');
    expect(result.page.total).toBe(0);
  });

  it('list reports canManage false when member.add is refused, whatever the viewer role is', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue('ADMIN');
    permissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    // The legacy role says ADMIN, the key does not: the key decides.
    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: 'ADMIN' }));
  });

  it('list reports viewerRole DEVELOPER and canManage false for a developer binding', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue('DEVELOPER');
    permissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: 'DEVELOPER' }));
  });

  it('list reports viewerRole null and canManage false for an agent', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue(null);
    permissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: null }));
  });

  it('US-003: list passes the principals filter down, defaulting to users', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    access.resolveMembership.mockResolvedValue('VIEWER');

    await service.list('proj', projectAdmin, { current: 1, size: 20 });
    // An omitted filter is the pre-US-003 listing: user rows only.
    expect(repo.findMemberPage).toHaveBeenLastCalledWith('p1', { current: 1, size: 20 }, 'users');

    await service.list('proj', projectAdmin, { current: 1, size: 20 }, 'all');
    expect(repo.findMemberPage).toHaveBeenLastCalledWith('p1', { current: 1, size: 20 }, 'all');
  });

  it('writes never assert the caller\'s admin role — the route key is the gate', async () => {
    repo.findUserByEmail.mockResolvedValue({ id: 'u1', disabled: false });
    // add reads the member once to refuse a duplicate and once to return the written row.
    repo.findMember.mockResolvedValueOnce(null).mockResolvedValueOnce(member('u1', 'DEVELOPER'));

    await expect(service.add('proj', { email: 'u1@k.t', roleKey: 'developer' }, projectAdmin)).resolves.toMatchObject({ role: 'DEVELOPER' });
  });

  it('add: unknown email is 404, duplicate member is 409', async () => {
    repo.findUserByEmail.mockResolvedValueOnce(null);
    repo.findUserIdByEmail.mockResolvedValueOnce(null);
    await expect(service.add('proj', { email: 'ghost@k.t', roleKey: 'viewer' }, globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);

    repo.findUserByEmail.mockResolvedValueOnce({ id: 'u1', disabled: false });
    repo.findUserIdByEmail.mockResolvedValueOnce('u1');
    repo.findMember.mockResolvedValueOnce(member('u1', 'VIEWER'));
    await expect(service.add('proj', { email: 'u1@k.t', roleKey: 'viewer' }, globalAdmin)).rejects.toMatchObject({ prefix: 'members', httpStatus: 409 });
  });

  it('add grants the roleKey and reads the written member', async () => {
    repo.findUserByEmail.mockResolvedValue({ id: 'u1', disabled: false });
    repo.findMember.mockResolvedValueOnce(null).mockResolvedValueOnce(member('u1', 'DEVELOPER'));
    expect(await service.add('proj', { email: 'u1@k.t', roleKey: 'developer' }, projectAdmin)).toMatchObject({ role: 'DEVELOPER' });
    expect(membership.createBinding).toHaveBeenCalledWith({ principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleKey: 'developer' }, { type: 'USER', id: 'pa' });
  });

  /**
   * US-004: every add runs the shared grant rules before it writes. The route's `member.add` key is the
   * gate, so the service asks `assertMayGrant` — role, scope, principal type, self-binding, escalation —
   * and only then binds.
   */
  describe('US-004: role keys through the grant rules', () => {
    beforeEach(() => {
      repo.findUserByEmail.mockResolvedValue({ id: 'u1', disabled: false });
      repo.findMember.mockResolvedValueOnce(null).mockResolvedValueOnce(member('u1', 'DEVELOPER'));
    });

    it('AC-3: calls assertMayGrant once with the requested key and the target, before createBinding', async () => {
      await service.add('proj', { email: 'u1@k.t', roleKey: 'triager' }, projectAdmin);

      expect(roles.assertMayGrant).toHaveBeenCalledTimes(1);
      expect(roles.assertMayGrant).toHaveBeenCalledWith(projectAdmin, {
        roleKey: 'triager',
        projectId: 'p1',
        principalType: 'USER',
        principalId: 'u1',
      });
      expect(roles.assertMayGrant.mock.invocationCallOrder[0]).toBeLessThan(
        membership.createBinding.mock.invocationCallOrder[0] as number,
      );
      expect(membership.createBinding).toHaveBeenCalledWith(
        { principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleKey: 'triager' },
        { type: 'USER', id: 'pa' },
      );
    });

    it('AC-3: an assertMayGrant rejection prevents createBinding', async () => {
      roles.assertMayGrant.mockRejectedValue(new ForbiddenAppException({}, 'permissions.escalation'));

      const error = await service.add('proj', { email: 'u1@k.t', roleKey: 'developer' }, projectAdmin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).prefix).toBe('permissions.escalation');
      expect(membership.createBinding).not.toHaveBeenCalled();
    });

    it('US-004 (P1l): a stray legacy role is ignored and the grant falls back to viewer', async () => {
      // The pipe strips `role`, so the service never reads it: a body that only carries the legacy field
      // grants the same least-privileged role as a body with neither field.
      await service.add('proj', { email: 'u1@k.t', role: 'ADMIN' } as never, projectAdmin);

      expect(roles.assertMayGrant).toHaveBeenCalledWith(projectAdmin, {
        roleKey: 'viewer',
        projectId: 'p1',
        principalType: 'USER',
        principalId: 'u1',
      });
      expect(membership.createBinding).toHaveBeenCalledWith(
        { principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleKey: 'viewer' },
        { type: 'USER', id: 'pa' },
      );
    });

    it('neither field grants viewer, and it is still granted through the rules', async () => {
      await service.add('proj', { email: 'u1@k.t' }, projectAdmin);

      expect(roles.assertMayGrant).toHaveBeenCalledWith(projectAdmin, {
        roleKey: 'viewer',
        projectId: 'p1',
        principalType: 'USER',
        principalId: 'u1',
      });
      expect(membership.createBinding).toHaveBeenCalledWith(
        { principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleKey: 'viewer' },
        { type: 'USER', id: 'pa' },
      );
    });

    it('US-004 (P1l): the roleKey decides and a legacy role beside it changes nothing', async () => {
      // `role: 'VIEWER'` would have been stripped by the pipe; the service sees only the key it grants.
      await service.add('proj', { email: 'u1@k.t', roleKey: 'developer' }, projectAdmin);

      expect(roles.assertMayGrant).toHaveBeenCalledWith(projectAdmin, {
        roleKey: 'developer',
        projectId: 'p1',
        principalType: 'USER',
        principalId: 'u1',
      });
      expect(membership.createBinding).toHaveBeenCalledTimes(1);
      expect(membership.createBinding).toHaveBeenCalledWith(
        { principal: { type: 'USER', id: 'u1' }, projectId: 'p1', roleKey: 'developer' },
        { type: 'USER', id: 'pa' },
      );
    });

    it('the user lookup and the disabled refusal come before the grant rules', async () => {
      repo.findUserByEmail.mockResolvedValueOnce(null);
      await expect(service.add('proj', { email: 'ghost@k.t', roleKey: 'triager' }, projectAdmin))
        .rejects.toMatchObject({ prefix: 'members.user', httpStatus: 404 });

      repo.findUserByEmail.mockResolvedValueOnce({ id: 'u1', disabled: true });
      await expect(service.add('proj', { email: 'u1@k.t', roleKey: 'triager' }, projectAdmin))
        .rejects.toMatchObject({ prefix: 'members.userDisabled', httpStatus: 409 });

      expect(roles.assertMayGrant).not.toHaveBeenCalled();
    });

    it('the existing-member 409 comes after the grant rules', async () => {
      repo.findMember.mockReset();
      repo.findMember.mockResolvedValue(member('u1', 'DEVELOPER'));

      await expect(service.add('proj', { email: 'u1@k.t', roleKey: 'triager' }, projectAdmin))
        .rejects.toMatchObject({ prefix: 'members', httpStatus: 409 });

      expect(roles.assertMayGrant).toHaveBeenCalledTimes(1);
      expect(membership.createBinding).not.toHaveBeenCalled();
    });
  });

  it('AC14: refuses to add a disabled user without creating membership', async () => {
    repo.findUserByEmail.mockResolvedValue({ id: 'disabled-user', disabled: true });
    repo.findUserIdByEmail.mockResolvedValue('disabled-user');

    // The disabled refusal is the `members.userDisabled.409` AppException (the
    // i18n key lives in `prefix`; the HTTP body renders it through the global
    // exception filter, which a service-level test does not run).
    const error = await service.add('proj', { email: 'disabled@k.t', roleKey: 'viewer' }, globalAdmin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).prefix).toBe('members.userDisabled');
    expect((error as ConflictAppException).httpStatus).toBe(409);

    expect(membership.createBinding).not.toHaveBeenCalled();
  });

  it('AC15: lists each member disabled state', async () => {
    repo.findMemberPage.mockResolvedValue({
      total: 2,
      current: 1,
      size: 20,
      hasNext: false,
      hasPrev: false,
      records: [member('disabled-user', 'VIEWER', true), member('enabled-user', 'DEVELOPER', false)],
    });
    access.resolveMembership.mockResolvedValue('ADMIN');

    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });

    expect(result.page.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'disabled-user', disabled: true }),
      expect.objectContaining({ userId: 'enabled-user', disabled: false }),
    ]));
  });
});
