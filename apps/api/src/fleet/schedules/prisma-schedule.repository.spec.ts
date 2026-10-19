import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaScheduleRepository } from './prisma-schedule.repository';
import { mayDispatch } from './schedule-access';

/**
 * US-004 (permissions P1b) — `findOwnerAccess` answers the schedule owner's project role from the
 * **access sources** the compatibility queries union (`userProjectRole`): the owner's legacy
 * `ProjectMember` row plus its PROJECT-scope bindings, in the schedule's project and `projectId`-null.
 * Existence, `disabled` and the global `User.role` are read exactly as before; only `projectRole`
 * moves.
 *
 * The DB-backed form of the same behaviour — US-004 AC-3 .. AC-6 over HTTP and through the real
 * ticker — lives in `test/integration/permissions/membership-fleet-consumers.integration.spec.ts`.
 * This spec pins the read path without a database: the stub answers `ProjectMember` only for the
 * exact compound key, so a read that goes back to that table alone cannot pass and a real binding row
 * is invisible to the legacy read.
 */

/** The scope the seeder gives each system role key the fixtures use. */
const ROLE_SCOPE: Readonly<Record<string, 'GLOBAL' | 'PROJECT'>> = {
  owner: 'GLOBAL',
  admin: 'GLOBAL',
  member: 'GLOBAL',
  agent: 'GLOBAL',
  'project-admin': 'PROJECT',
  developer: 'PROJECT',
  reviewer: 'PROJECT',
  viewer: 'PROJECT',
};

interface UserRow {
  id: string;
  role: string;
  disabled: boolean;
}

interface LegacyMemberRow {
  projectId: string;
  userId: string;
  role: string;
}

interface BindingRow {
  principalType: string;
  principalId: string;
  projectId: string | null;
  roleKey: string;
  createdAt: Date;
}

const userRow = (id: string, over: Partial<UserRow> = {}): UserRow => ({ id, role: 'MEMBER', disabled: false, ...over });

const bind = (roleKey: string, projectId: string | null, over: Partial<BindingRow> = {}): BindingRow => ({
  principalType: 'USER',
  principalId: 'u1',
  projectId,
  roleKey,
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  ...over,
});

/** The subset of the generated client `findOwnerAccess` reads, backed by plain rows. */
function stubClient(rows: { users: UserRow[]; members: LegacyMemberRow[]; bindings: BindingRow[]; liveProjects: string[] }) {
  const userFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const user = rows.users.find((row) => row.id === args.where.id);
    return user ? { disabled: user.disabled, role: user.role } : null;
  });

  const projectMemberFindUnique = vi.fn(async (args: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
    const { projectId, userId } = args.where.projectId_userId;
    const member = rows.members.find((row) => row.projectId === projectId && row.userId === userId);
    return member ? { role: member.role } : null;
  });

  const roleBindingFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
    const where = args.where ?? {};
    const principalType = where['principalType'] as string | undefined;
    const principalId = where['principalId'] as string | undefined;
    const projectId = where['projectId'] as string | null | undefined;
    const or = where['OR'] as Array<{ projectId: string | null }> | undefined;
    const scope = (where['role'] as { scope?: string } | undefined)?.scope;
    return rows.bindings
      .filter((row) => principalType === undefined || row.principalType === principalType)
      .filter((row) => principalId === undefined || row.principalId === principalId)
      .filter((row) => !or || or.some((clause) => clause.projectId === row.projectId))
      .filter((row) => projectId === undefined || row.projectId === projectId)
      .filter((row) => scope === undefined || ROLE_SCOPE[row.roleKey] === scope)
      .map((row) => ({
        projectId: row.projectId,
        createdAt: row.createdAt,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        role: { key: row.roleKey, scope: ROLE_SCOPE[row.roleKey] },
      }));
  });

  const projectCount = vi.fn(async (args: { where: { id: string; deletedAt: null } }) =>
    rows.liveProjects.includes(args.where.id) ? 1 : 0,
  );

  return {
    user: { findUnique: userFindUnique },
    projectMember: { findUnique: projectMemberFindUnique },
    roleBinding: { findMany: roleBindingFindMany },
    project: { count: projectCount },
  };
}

function repositoryFor(rows: {
  users: UserRow[];
  members: LegacyMemberRow[];
  bindings: BindingRow[];
  liveProjects?: string[];
}) {
  const client = stubClient({ liveProjects: ['p1', 'p2'], ...rows });
  const prisma = { client: client as unknown as PrismaClient };
  return {
    repository: new PrismaScheduleRepository(prisma as unknown as PrismaService<PrismaClient>),
    client,
  };
}

describe('PrismaScheduleRepository — findOwnerAccess (US-004)', () => {
  const owner = userRow('u1');

  it('answers DEVELOPER for an owner whose only source in the project is a developer binding', async () => {
    const { repository, client } = repositoryFor({ users: [owner], members: [], bindings: [bind('developer', 'p1')] });

    await expect(repository.findOwnerAccess('p1', 'u1')).resolves.toEqual({
      exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'DEVELOPER',
    });
    expect(client.roleBinding.findMany).toHaveBeenCalled();
  });

  it('answers VIEWER for an owner whose only source in the project is a viewer binding', async () => {
    const { repository } = repositoryFor({ users: [owner], members: [], bindings: [bind('viewer', 'p1')] });

    await expect(repository.findOwnerAccess('p1', 'u1')).resolves.toEqual({
      exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'VIEWER',
    });
  });

  it('keeps a legacy ProjectMember row, and takes the strongest of a row and a binding', async () => {
    const legacy = repositoryFor({
      users: [owner],
      members: [{ projectId: 'p1', userId: 'u1', role: 'DEVELOPER' }],
      bindings: [],
    });
    const both = repositoryFor({
      users: [owner],
      members: [{ projectId: 'p1', userId: 'u1', role: 'VIEWER' }],
      bindings: [bind('project-admin', 'p1')],
    });

    await expect(legacy.repository.findOwnerAccess('p1', 'u1')).resolves.toEqual(expect.objectContaining({ projectRole: 'DEVELOPER' }));
    await expect(both.repository.findOwnerAccess('p1', 'u1')).resolves.toEqual(expect.objectContaining({ projectRole: 'ADMIN' }));
  });

  it('answers the projectId-null project binding role, and never a GLOBAL-scope binding', async () => {
    const global = repositoryFor({ users: [owner], members: [], bindings: [bind('reviewer', null)] });
    const unscoped = repositoryFor({ users: [owner], members: [], bindings: [bind('member', null), bind('admin', null)] });

    await expect(global.repository.findOwnerAccess('p1', 'u1')).resolves.toEqual(expect.objectContaining({ projectRole: 'VIEWER' }));
    await expect(unscoped.repository.findOwnerAccess('p1', 'u1')).resolves.toEqual(expect.objectContaining({ projectRole: null }));
  });

  it('answers no source for a binding in another project', async () => {
    const { repository } = repositoryFor({ users: [owner], members: [], bindings: [bind('developer', 'p2')] });

    await expect(repository.findOwnerAccess('p1', 'u1')).resolves.toEqual(expect.objectContaining({ projectRole: null }));
  });

  it('preserves the existence, disabled and globalRole fields', async () => {
    const { repository } = repositoryFor({
      users: [userRow('u1', { disabled: true }), userRow('u2', { role: 'ADMIN' })],
      members: [],
      bindings: [],
    });

    await expect(repository.findOwnerAccess('p1', 'u1')).resolves.toEqual({
      exists: true, disabled: true, globalRole: 'MEMBER', projectRole: null,
    });
    await expect(repository.findOwnerAccess('p1', 'u2')).resolves.toEqual({
      exists: true, disabled: false, globalRole: 'ADMIN', projectRole: null,
    });
  });

  it('reports a missing user and reads no membership for it', async () => {
    const { repository, client } = repositoryFor({ users: [], members: [], bindings: [bind('developer', 'p1', { principalId: 'ghost' })] });

    await expect(repository.findOwnerAccess('p1', 'ghost')).resolves.toEqual({
      exists: false, disabled: false, globalRole: '', projectRole: null,
    });
    expect(client.projectMember.findUnique).not.toHaveBeenCalled();
  });

  it('AC-5 / AC-6: mayDispatch accepts a developer-binding-only owner and still refuses a viewer-only one', async () => {
    const developer = repositoryFor({ users: [owner], members: [], bindings: [bind('developer', 'p1')] });
    const viewer = repositoryFor({ users: [owner], members: [], bindings: [bind('viewer', 'p1')] });

    expect(mayDispatch(await developer.repository.findOwnerAccess('p1', 'u1'))).toBe(true);
    expect(mayDispatch(await viewer.repository.findOwnerAccess('p1', 'u1'))).toBe(false);
  });
});
