import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../generated/prisma/client';
import { MEMBERSHIP_READ_CAP } from '../permissions/legacy-membership.queries';
import { PrismaProjectRepository } from './prisma-project.repository';

/**
 * US-002 (permissions P1b) — the four project reads answer from the **access sources** the
 * compatibility queries union: the principal's legacy row (`ProjectMember` for a user,
 * `AgentProject` for an agent) plus its PROJECT-scope bindings, in the project and `projectId`-null.
 *
 * The DB-backed form of the same behaviour — US-002's acceptance criteria over HTTP — lives in
 * `test/integration/permissions/membership-project-access.integration.spec.ts`. This spec pins the
 * repository's read path without a database: the stub answers `project.findMany` only from the ids
 * the implementation asks for, so a read that filters by a relation (`members: { some }`) instead of
 * the access sources cannot pass, and a real binding row is invisible to the legacy query.
 *
 * The queries' own union logic (which source counts, strongest role) is pinned by
 * `src/permissions/legacy-membership.queries.spec.ts`; here the question is only that each method
 * reaches it.
 */

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  key: string;
  description: string | null;
  brief: string | null;
  gitRemoteUrl: string | null;
  autoIndexOnClose: boolean;
  autoAssign: string;
  graphifyEnabled: boolean;
  graphifyLastImportedAt: Date | null;
  ciWebhookToken: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

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
  joinedAt: Date;
}

interface RosterRow {
  projectId: string;
  agentId: string;
  addedById: string | null;
  createdAt: Date;
}

const projectRow = (id: string, name: string, deletedAt: Date | null = null): ProjectRow => ({
  id,
  name,
  slug: id,
  key: id.toUpperCase(),
  description: null,
  brief: null,
  gitRemoteUrl: null,
  autoIndexOnClose: true,
  autoAssign: 'OFF',
  graphifyEnabled: false,
  graphifyLastImportedAt: null,
  ciWebhookToken: null,
  deletedAt,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

/**
 * The subset of the generated client the membership queries read, backed by plain rows. `project`
 * answers `where.id.in` (that is the whole point of reading bindings: the ids decide access) and
 * `orderBy`/`take`/`select` like Prisma does.
 */
function stubClient(rows: {
  projects: ProjectRow[];
  members: LegacyMemberRow[];
  roster: RosterRow[];
  bindings: BindingRow[];
}) {
  interface FindManyArgs {
    where?: Record<string, unknown>;
    select?: Record<string, boolean>;
    orderBy?: Record<string, string>;
    take?: number;
  }

  const projectFindMany = vi.fn(async (args: FindManyArgs = {}) => {
    const where = args.where ?? {};
    const idFilter = where['id'] as { in?: string[]; gt?: string } | undefined;
    const live = rows.projects.filter((row) => row.deletedAt === null);
    // `{ in, gt }` is one filter: the id set, then everything after the last id of the previous page.
    let found = live;
    if (idFilter?.in !== undefined) found = found.filter((row) => (idFilter.in as string[]).includes(row.id));
    if (idFilter?.gt !== undefined) found = found.filter((row) => row.id > (idFilter.gt as string));
    const ordered = [...found].sort((left, right) => {
      const orderBy = args.orderBy ?? {};
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
      for (const field of Object.keys(args.select as Record<string, boolean>)) {
        out[field] = row[field as keyof ProjectRow];
      }
      return out as unknown as ProjectRow;
    });
  });

  const projectMemberFindUnique = vi.fn(async (args: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
    const { projectId, userId } = args.where.projectId_userId;
    const row = rows.members.find((m) => m.projectId === projectId && m.userId === userId);
    return row ? { role: row.role } : null;
  });

  const projectMemberFindMany = vi.fn(async (args: { where?: { userId?: string } } = {}) => {
    const userId = args.where?.userId;
    return rows.members
      .filter((row) => userId === undefined || row.userId === userId)
      .map((row) => ({ projectId: row.projectId, userId: row.userId, role: row.role, joinedAt: row.joinedAt }));
  });

  const agentProjectFindUnique = vi.fn(async (args: { where: { agentId_projectId: { agentId: string; projectId: string } } }) => {
    const { agentId, projectId } = args.where.agentId_projectId;
    const row = rows.roster.find((r) => r.projectId === projectId && r.agentId === agentId);
    return row ? { agentId: row.agentId } : null;
  });

  const agentProjectFindMany = vi.fn(async (args: { where?: { agentId?: string } } = {}) => {
    const agentId = args.where?.agentId;
    return rows.roster
      .filter((row) => agentId === undefined || row.agentId === agentId)
      .map((row) => ({ projectId: row.projectId, agentId: row.agentId, addedById: row.addedById, createdAt: row.createdAt }));
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

  return {
    project: {
      findMany: projectFindMany,
      count: vi.fn(async (args: { where: { id: string; deletedAt: null } }) =>
        rows.projects.filter((row) => row.id === args.where.id && row.deletedAt === null).length,
      ),
    },
    projectMember: { findUnique: projectMemberFindUnique, findMany: projectMemberFindMany },
    agentProject: { findUnique: agentProjectFindUnique, findMany: agentProjectFindMany },
    roleBinding: { findMany: roleBindingFindMany },
    user: { count: vi.fn(async () => 0) },
  };
}

function repositoryFor(rows: {
  projects: ProjectRow[];
  members: LegacyMemberRow[];
  roster: RosterRow[];
  bindings: BindingRow[];
}): { repository: PrismaProjectRepository; client: ReturnType<typeof stubClient> } {
  const client = stubClient(rows);
  const prisma = { client: client as unknown as PrismaClient };
  return {
    repository: new PrismaProjectRepository(prisma as unknown as PrismaService<PrismaClient>),
    client,
  };
}

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

describe('PrismaProjectRepository — membership reads (US-002)', () => {
  const projects = [projectRow('p1', 'Alpha'), projectRow('p2', 'Beta'), projectRow('gone', 'Gamma', new Date('2026-01-01T00:00:00.000Z'))];

  describe('findMembershipRole', () => {
    it('answers the legacy role a developer binding maps to, with no ProjectMember row', async () => {
      const { repository, client } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('USER', 'u1', 'developer', 'p1')],
      });

      await expect(repository.findMembershipRole('p1', 'u1')).resolves.toBe('DEVELOPER');
      expect(client.roleBinding.findMany).toHaveBeenCalled();
    });

    it('keeps a legacy ProjectMember role', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [{ projectId: 'p1', userId: 'u1', role: 'DEVELOPER', joinedAt: new Date() }],
        roster: [],
        bindings: [],
      });

      await expect(repository.findMembershipRole('p1', 'u1')).resolves.toBe('DEVELOPER');
    });

    it('takes the strongest of a legacy row and a binding', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [{ projectId: 'p1', userId: 'u1', role: 'VIEWER', joinedAt: new Date() }],
        roster: [],
        bindings: [bind('USER', 'u1', 'project-admin', 'p1')],
      });

      await expect(repository.findMembershipRole('p1', 'u1')).resolves.toBe('ADMIN');
    });

    it('answers null for a user with no source, and ignores a GLOBAL-scope binding', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('USER', 'u1', 'member', null), bind('USER', 'u1', 'admin', null)],
      });

      await expect(repository.findMembershipRole('p1', 'u1')).resolves.toBeNull();
    });

    it('answers the projectId-null project binding role (reviewer -> VIEWER)', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('USER', 'u1', 'reviewer', null)],
      });

      await expect(repository.findMembershipRole('p1', 'u1')).resolves.toBe('VIEWER');
    });
  });

  describe('isAgentOnRoster', () => {
    it('answers true for an agent whose only source is a viewer binding', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('AGENT', 'a1', 'viewer', 'p1')],
      });

      await expect(repository.isAgentOnRoster('p1', 'a1')).resolves.toBe(true);
    });

    it('keeps a legacy AgentProject row, and answers false without any source', async () => {
      const rostered = repositoryFor({
        projects,
        members: [],
        roster: [{ projectId: 'p1', agentId: 'a1', addedById: null, createdAt: new Date() }],
        bindings: [],
      });
      const none = repositoryFor({ projects, members: [], roster: [], bindings: [] });

      await expect(rostered.repository.isAgentOnRoster('p1', 'a1')).resolves.toBe(true);
      await expect(none.repository.isAgentOnRoster('p1', 'a1')).resolves.toBe(false);
    });

    it('does not let a GLOBAL-scope agent binding become project reach', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('AGENT', 'a1', 'agent', null)],
      });

      await expect(repository.isAgentOnRoster('p1', 'a1')).resolves.toBe(false);
    });
  });

  describe('findAllForUser', () => {
    it('lists the projects a developer binding names and nothing else', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('USER', 'u1', 'developer', 'p1'), bind('USER', 'u1', 'developer', 'gone')],
      });

      const found = await repository.findAllForUser('u1');

      expect(found.map((project) => project.slug)).toEqual(['p1']);
    });

    it('unions a legacy row with a binding and de-duplicates the project', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [{ projectId: 'p2', userId: 'u1', role: 'DEVELOPER', joinedAt: new Date() }],
        roster: [],
        bindings: [bind('USER', 'u1', 'viewer', 'p2'), bind('USER', 'u1', 'viewer', 'p1')],
      });

      const found = await repository.findAllForUser('u1');

      expect(found.map((project) => project.slug)).toEqual(['p1', 'p2']);
    });

    it('lists every non-deleted project for a projectId-null project binding', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('USER', 'u1', 'developer', null)],
      });

      const found = await repository.findAllForUser('u1');

      expect(found.map((project) => project.slug)).toEqual(['p1', 'p2']);
    });

    it('answers [] for a user with no source and for an unknown user', async () => {
      const { repository } = repositoryFor({ projects, members: [], roster: [], bindings: [] });

      await expect(repository.findAllForUser('u1')).resolves.toEqual([]);
      await expect(repository.findAllForUser('ghost')).resolves.toEqual([]);
    });
  });

  describe('findAllForAgent', () => {
    it('lists the projects of the agent bindings and of its roster row', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [{ projectId: 'p2', agentId: 'a1', addedById: null, createdAt: new Date() }],
        bindings: [bind('AGENT', 'a1', 'viewer', 'p1')],
      });

      const found = await repository.findAllForAgent('a1');

      expect(found.map((project) => project.slug)).toEqual(['p1', 'p2']);
    });

    it('never returns a soft-deleted project', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [{ projectId: 'gone', agentId: 'a1', addedById: null, createdAt: new Date() }],
        bindings: [bind('AGENT', 'a1', 'viewer', 'gone')],
      });

      await expect(repository.findAllForAgent('a1')).resolves.toEqual([]);
    });

    it('lists every non-deleted project for a projectId-null project binding', async () => {
      const { repository } = repositoryFor({
        projects,
        members: [],
        roster: [],
        bindings: [bind('AGENT', 'a1', 'developer', null)],
      });

      const found = await repository.findAllForAgent('a1');

      expect(found.map((project) => project.slug)).toEqual(['p1', 'p2']);
    });

    it('answers [] for an unrostered agent', async () => {
      const { repository } = repositoryFor({ projects, members: [], roster: [], bindings: [] });

      await expect(repository.findAllForAgent('a1')).resolves.toEqual([]);
    });

    it('US-002 AC-11: a projectId-null project binding lists every live project past the read cap', async () => {
      const total = MEMBERSHIP_READ_CAP + 5;
      const bulk = Array.from({ length: total }, (_, index) =>
        projectRow(`p${String(index).padStart(5, '0')}`, `Bulk ${index}`),
      );
      const { repository } = repositoryFor({
        projects: bulk,
        members: [],
        roster: [],
        bindings: [bind('AGENT', 'a1', 'developer', null)],
      });

      const found = await repository.findAllForAgent('a1');

      expect(found).toHaveLength(total);
      expect(found[0]?.id).toBe('p00000');
      expect(found[found.length - 1]?.id).toBe(`p${String(total - 1).padStart(5, '0')}`);
    });

    it('US-002 AC-11: the same holds for a user project list, and excludes a soft-deleted project past the cap', async () => {
      const total = MEMBERSHIP_READ_CAP + 5;
      const bulk = Array.from({ length: total }, (_, index) =>
        projectRow(`p${String(index).padStart(5, '0')}`, `Bulk ${index}`),
      );
      bulk[total - 1] = projectRow(`p${String(total - 1).padStart(5, '0')}`, 'Gone', new Date('2026-01-01T00:00:00.000Z'));
      const { repository } = repositoryFor({
        projects: bulk,
        members: [],
        roster: [],
        bindings: [bind('USER', 'u1', 'reviewer', null)],
      });

      const found = await repository.findAllForUser('u1');

      expect(found).toHaveLength(total - 1);
    });
  });
});
