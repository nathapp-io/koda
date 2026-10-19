import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaFleetActivityRepository } from './prisma-fleet-activity.repository';

/**
 * US-004 (permissions P1b) — `findMemberProjectIds` answers the activity scope from the
 * **access sources** the compatibility queries union (`accessibleProjectIds`): the user's legacy
 * `ProjectMember` rows plus its PROJECT-scope bindings, in the project and `projectId`-null.
 *
 * The DB-backed form of the same behaviour — US-004 AC-1 and AC-2 over HTTP — lives in
 * `test/integration/permissions/membership-fleet-consumers.integration.spec.ts`. This spec pins the
 * repository's read path without a database: the stub answers `project.findMany` only from the ids
 * the implementation asks for, so a read that goes back to `ProjectMember` alone cannot pass and a
 * real binding row is invisible to the legacy read.
 *
 * The queries' own union logic (which source counts, the strongest role, the paging bound) is pinned
 * by `src/permissions/legacy-membership.queries.spec.ts`; here the question is only that the method
 * reaches it.
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

interface ProjectRow {
  id: string;
  deletedAt: Date | null;
}

interface BindingRow {
  principalType: string;
  principalId: string;
  projectId: string | null;
  roleKey: string;
  createdAt: Date;
}

interface LegacyMemberRow {
  projectId: string;
  userId: string;
  role: string;
}

const projectRow = (id: string, deletedAt: Date | null = null): ProjectRow => ({ id, deletedAt });

const bind = (
  principalType: 'USER' | 'AGENT',
  principalId: string,
  roleKey: string,
  projectId: string | null,
): BindingRow => ({
  principalType,
  principalId,
  projectId,
  roleKey,
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
});

/** The subset of the generated client `accessibleProjectIds` reads, backed by plain rows. */
function stubClient(rows: { projects: ProjectRow[]; members: LegacyMemberRow[]; bindings: BindingRow[] }) {
  const projectMemberFindMany = vi.fn(async (args: { where?: { userId?: string } } = {}) => {
    const userId = args.where?.userId;
    return rows.members
      .filter((row) => userId === undefined || row.userId === userId)
      .map((row) => ({ projectId: row.projectId, userId: row.userId, role: row.role }));
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

  const projectFindMany = vi.fn(async (args: { where?: Record<string, unknown>; take?: number } = {}) => {
    const idFilter = (args.where?.['id'] ?? undefined) as { in?: string[]; gt?: string } | undefined;
    let found = rows.projects.filter((row) => row.deletedAt === null);
    if (idFilter?.in !== undefined) found = found.filter((row) => (idFilter.in as string[]).includes(row.id));
    if (idFilter?.gt !== undefined) found = found.filter((row) => row.id > (idFilter.gt as string));
    const ordered = [...found].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return ordered.slice(0, args.take ?? ordered.length).map((row) => ({ id: row.id }));
  });

  return { projectMember: { findMany: projectMemberFindMany }, roleBinding: { findMany: roleBindingFindMany }, project: { findMany: projectFindMany } };
}

function repositoryFor(rows: { projects: ProjectRow[]; members: LegacyMemberRow[]; bindings: BindingRow[] }) {
  const client = stubClient(rows);
  const prisma = { client: client as unknown as PrismaClient };
  return {
    repository: new PrismaFleetActivityRepository(prisma as unknown as PrismaService<PrismaClient>),
    client,
  };
}

describe('PrismaFleetActivityRepository — findMemberProjectIds (US-004)', () => {
  const projects = [projectRow('p1'), projectRow('p2'), projectRow('gone', new Date('2026-01-01T00:00:00.000Z'))];

  it('answers p1 for a user whose only source there is a developer binding', async () => {
    const { repository, client } = repositoryFor({ projects, members: [], bindings: [bind('USER', 'u1', 'developer', 'p1')] });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual(['p1']);
    expect(client.roleBinding.findMany).toHaveBeenCalled();
    expect(client.projectMember.findMany).toHaveBeenCalled();
  });

  it('keeps the projects of the legacy ProjectMember rows', async () => {
    const { repository } = repositoryFor({
      projects,
      members: [{ projectId: 'p2', userId: 'u1', role: 'DEVELOPER' }],
      bindings: [],
    });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual(['p2']);
  });

  it('unions a legacy row with a binding and de-duplicates the project', async () => {
    const { repository } = repositoryFor({
      projects,
      members: [{ projectId: 'p2', userId: 'u1', role: 'VIEWER' }],
      bindings: [bind('USER', 'u1', 'developer', 'p2'), bind('USER', 'u1', 'viewer', 'p1')],
    });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual(['p1', 'p2']);
  });

  it('answers every non-deleted project for a projectId-null PROJECT binding', async () => {
    const { repository } = repositoryFor({ projects, members: [], bindings: [bind('USER', 'u1', 'developer', null)] });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual(['p1', 'p2']);
  });

  it('never answers a soft-deleted project, whatever the source', async () => {
    const { repository } = repositoryFor({
      projects,
      members: [{ projectId: 'gone', userId: 'u1', role: 'DEVELOPER' }],
      bindings: [bind('USER', 'u1', 'developer', 'gone')],
    });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual([]);
  });

  it('never treats a GLOBAL-scope binding as a membership source', async () => {
    const { repository } = repositoryFor({
      projects,
      members: [],
      bindings: [bind('USER', 'u1', 'member', null), bind('USER', 'u1', 'admin', null)],
    });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual([]);
  });

  it('ignores another principal\'s bindings and answers [] for a user with no source', async () => {
    const { repository } = repositoryFor({ projects, members: [], bindings: [bind('USER', 'u2', 'developer', 'p1')] });

    await expect(repository.findMemberProjectIds('u1')).resolves.toEqual([]);
    await expect(repository.findMemberProjectIds('ghost')).resolves.toEqual([]);
  });

  it('re-reads the sources on every call: nothing is cached', async () => {
    const { repository, client } = repositoryFor({ projects, members: [], bindings: [bind('USER', 'u1', 'developer', 'p1')] });

    await repository.findMemberProjectIds('u1');
    await repository.findMemberProjectIds('u1');

    expect(client.roleBinding.findMany).toHaveBeenCalledTimes(2);
    expect(client.projectMember.findMany).toHaveBeenCalledTimes(2);
  });
});
