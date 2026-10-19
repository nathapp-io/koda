import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../generated/prisma/client';
import { MEMBERSHIP_READ_CAP } from '../permissions/legacy-membership.queries';
import { PrismaHomeRepository } from './prisma-home.repository';

/**
 * US-002 (permissions P1b) — `GET /home`'s project list is the caller's **access sources**: the legacy
 * `ProjectMember` rows unioned with the PROJECT-scope bindings, in the projects the caller is bound
 * in and, for a `projectId`-null project binding, in every non-deleted project.
 *
 * The DB-backed acceptance criterion (US-002 AC-13) is in
 * `test/integration/permissions/membership-project-access.integration.spec.ts`. This spec pins the
 * home repository's own read without a database: the stub answers `project.findMany` from the ids the
 * implementation asks for, so a read that filters by the `members` relation cannot pass.
 */

interface ProjectRow {
  id: string;
  name: string;
  key: string;
  slug: string;
  description: string | null;
  deletedAt: Date | null;
}

const PROJECTS: ProjectRow[] = [
  { id: 'p1', name: 'Alpha', key: 'A', slug: 'p1', description: null, deletedAt: null },
  { id: 'p2', name: 'Beta', key: 'B', slug: 'p2', description: null, deletedAt: null },
  { id: 'gone', name: 'Gamma', key: 'G', slug: 'gone', description: null, deletedAt: new Date('2026-01-01T00:00:00.000Z') },
];

/** The scope the seeder gives each system role key the fixtures use. */
const ROLE_SCOPE: Readonly<Record<string, 'GLOBAL' | 'PROJECT'>> = {
  admin: 'GLOBAL',
  member: 'GLOBAL',
  'project-admin': 'PROJECT',
  developer: 'PROJECT',
  reviewer: 'PROJECT',
  viewer: 'PROJECT',
};

interface BindingRow {
  principalType: 'USER' | 'AGENT';
  principalId: string;
  projectId: string | null;
  roleKey: string;
}

interface StubArgs {
  where?: Record<string, unknown>;
  select?: Record<string, boolean>;
  orderBy?: Record<string, string>;
  take?: number;
}

function stubClient(
  bindings: BindingRow[],
  members: Array<{ projectId: string; userId: string }> = [],
  projects: ProjectRow[] = PROJECTS,
) {
  const projectFindMany = vi.fn(async (args: StubArgs = {}) => {
    const where = args.where ?? {};
    const idFilter = where['id'] as { in?: string[]; gt?: string } | undefined;
    const live = projects.filter((row) => row.deletedAt === null);
    // `{ in, gt }` is one filter: the id set, then everything after the last id of the previous page.
    let found = live;
    if (idFilter?.in !== undefined) found = found.filter((row) => (idFilter.in as string[]).includes(row.id));
    if (idFilter?.gt !== undefined) found = found.filter((row) => row.id > (idFilter.gt as string));
    const orderBy = args.orderBy ?? {};
    const ordered = [...found].sort((left, right) => {
      for (const [field, direction] of Object.entries(orderBy)) {
        const a = String(left[field as keyof ProjectRow]);
        const b = String(right[field as keyof ProjectRow]);
        if (a !== b) return direction === 'desc' ? (a < b ? 1 : -1) : a < b ? -1 : 1;
      }
      return 0;
    });
    const sliced = ordered.slice(0, args.take ?? ordered.length);
    if (!args.select) return sliced.map((row) => ({ ...row }));
    return sliced.map((row) => {
      const out: Record<string, unknown> = {};
      for (const field of Object.keys(args.select as Record<string, boolean>)) out[field] = row[field as keyof ProjectRow];
      return out;
    });
  });

  return {
    project: { findMany: projectFindMany },
    projectMember: {
      findMany: vi.fn(async (args: { where?: { userId?: string } } = {}) => {
        const userId = args.where?.userId;
        return members
          .filter((row) => userId === undefined || row.userId === userId)
          .map((row) => ({ projectId: row.projectId }));
      }),
    },
    roleBinding: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
        const where = args.where ?? {};
        const projectIds = (where['OR'] as Array<{ projectId: string | null }> | undefined)?.map((clause) => clause.projectId);
        const scope = (where['role'] as { scope?: string } | undefined)?.scope;
        return bindings
          .filter((row) => where['principalType'] === undefined || row.principalType === where['principalType'])
          .filter((row) => where['principalId'] === undefined || row.principalId === where['principalId'])
          .filter((row) => projectIds === undefined || projectIds.includes(row.projectId))
          .filter((row) => scope === undefined || ROLE_SCOPE[row.roleKey] === scope)
          .map((row) => ({
            projectId: row.projectId,
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
            grantedByType: 'SYSTEM',
            grantedById: 'test',
            role: { key: row.roleKey, scope: ROLE_SCOPE[row.roleKey] },
          }));
      }),
    },
  };
}

function repositoryFor(
  bindings: BindingRow[],
  members: Array<{ projectId: string; userId: string }> = [],
  projects: ProjectRow[] = PROJECTS,
): { repository: PrismaHomeRepository; client: ReturnType<typeof stubClient> } {
  const client = stubClient(bindings, members, projects);
  const prisma = { client: client as unknown as PrismaClient };
  return { repository: new PrismaHomeRepository(prisma as unknown as PrismaService<PrismaClient>), client };
}

const bind = (principalId: string, roleKey: string, projectId: string | null): BindingRow => ({
  principalType: 'USER',
  principalId,
  projectId,
  roleKey,
});

describe('PrismaHomeRepository.findProjects — membership reads (US-002)', () => {
  it('lists the projects a developer binding names, in home name order', async () => {
    const { repository, client } = repositoryFor([
      bind('u1', 'developer', 'p1'),
      bind('u1', 'developer', 'gone'),
    ]);

    const projects = await repository.findProjects({ id: 'u1', globalAdmin: false });

    expect(projects.map((project) => project.slug)).toEqual(['p1']);
    expect(client.roleBinding.findMany).toHaveBeenCalled();
  });

  it('orders by name ascending and unions the legacy row with the bindings', async () => {
    const { repository } = repositoryFor(
      [bind('u1', 'viewer', 'p2')],
      [{ projectId: 'p1', userId: 'u1' }],
    );

    const projects = await repository.findProjects({ id: 'u1', globalAdmin: false });

    expect(projects.map((project) => project.slug)).toEqual(['p1', 'p2']);
  });

  it('lists every non-deleted project for a projectId-null project binding', async () => {
    const { repository } = repositoryFor([bind('u1', 'reviewer', null)]);

    const projects = await repository.findProjects({ id: 'u1', globalAdmin: false });

    expect(projects.map((project) => project.slug)).toEqual(['p1', 'p2']);
  });

  it('lists nothing for a user whose only binding is a GLOBAL-scope one', async () => {
    const { repository } = repositoryFor([bind('u1', 'member', null), bind('u1', 'admin', null)]);

    await expect(repository.findProjects({ id: 'u1', globalAdmin: false })).resolves.toEqual([]);
  });

  it('answers [] for a user with no source at all', async () => {
    const { repository } = repositoryFor([]);

    await expect(repository.findProjects({ id: 'u1', globalAdmin: false })).resolves.toEqual([]);
  });

  it('keeps every non-deleted project for a global admin, without reading membership', async () => {
    const { repository, client } = repositoryFor([]);

    const projects = await repository.findProjects({ id: 'u1', globalAdmin: true });

    expect(projects.map((project) => project.slug)).toEqual(['p1', 'p2']);
    expect(client.roleBinding.findMany).not.toHaveBeenCalled();
  });

  it('US-002 AC-11: a projectId-null project binding lists every live project past the read cap', async () => {
    const total = MEMBERSHIP_READ_CAP + 5;
    const bulk: ProjectRow[] = Array.from({ length: total }, (_, index) => ({
      id: `p${String(index).padStart(5, '0')}`,
      name: `Bulk ${String(index).padStart(5, '0')}`,
      key: 'BULK',
      slug: `p${String(index).padStart(5, '0')}`,
      description: null,
      deletedAt: null,
    }));
    const { repository } = repositoryFor([bind('u1', 'developer', null)], [], bulk);

    const projects = await repository.findProjects({ id: 'u1', globalAdmin: false });

    expect(projects).toHaveLength(total);
  });
});
