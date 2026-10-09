/**
 * US-002 — the project list is scoped to the principal's memberships.
 *
 *   AC6  findAllForPrincipal returns exactly the projects a user principal is a member of
 *   AC7  … every non-deleted project for a global ADMIN user principal
 *   AC8  … every non-deleted project for an agent principal
 *   AC9  … never a soft-deleted project, even for a member of it
 *
 * S4c US-001 changes AC8 for agents: while `AGENT_PROJECT_SCOPING` is on
 * (the default) an agent gets exactly the non-deleted projects on its
 * `AgentProject` roster (AC11); only an explicit `off` — and the pre-S4c agent
 * reach — returns every non-deleted project (AC12).
 *
 * The repository double mirrors `PrismaProjectRepository`: it yields only
 * non-deleted rows, a membership-scoped selector yields only the caller's rows
 * (their `ProjectMember` rows), and the agent roster selector yields only the
 * caller's roster rows. The DB-backed form of AC6–AC9 — real repository, real
 * membership rows — lives in
 * `test/integration/projects/project-membership-gate.integration.spec.ts`.
 */
import { ProjectsService } from '../../../src/projects/projects.service';
import { PrismaProjectRepository } from '../../../src/projects/prisma-project.repository';
import { ProjectAccessService } from '../../../src/projects/project-access.service';
import { RagService } from '../../../src/rag/rag.service';
import type { ProjectDomain } from '../../../src/projects/domain/project.domain';
import type {
  AgentPrincipal,
  UserPrincipal,
} from '../../../src/auth/principal/koda-principal.types';

const CREATED = new Date('2026-09-01T00:00:00.000Z');

function project(id: string, slug: string, key: string, deletedAt: Date | null = null): ProjectDomain {
  return {
    id,
    name: slug,
    slug,
    key,
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
    ciWebhookToken: null,
    deletedAt,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

const PROJECT_A = project('proj-a', 'alpha', 'ALPHA');
const PROJECT_B = project('proj-b', 'bravo', 'BRAVO');
/** A third project that exists but has no member rows at all. */
const PROJECT_C = project('proj-c', 'charlie', 'CHARLIE');
/** Soft-deleted, and `user-multi` is still a member of it. */
const PROJECT_D = project('proj-d', 'delta', 'DELTA', new Date('2026-09-20T00:00:00.000Z'));

const NON_DELETED = [PROJECT_A, PROJECT_B, PROJECT_C];
const ALL_ROWS = [PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D];

/** ProjectMember rows, keyed by user id (including the soft-deleted project). */
const MEMBERSHIPS: Record<string, string[]> = {
  'user-multi': ['alpha', 'bravo', 'delta'],
};

/** AgentProject roster rows, keyed by agent id (S4c US-001). `delta` is soft-deleted. */
const AGENT_ROSTER: Record<string, string[]> = {
  'agent-1': ['alpha', 'bravo', 'delta'],
};

type RepoDouble = Record<string, jest.Mock>;

/**
 * The rows a membership-scoped selector yields. A bare user id (or a user
 * principal) is scoped to that user's `ProjectMember` rows; agents and global
 * ADMIN principals are cross-project and get every non-deleted row; no selector
 * at all is the unscoped list.
 */
function rowsForSelector(selector: unknown): ProjectDomain[] {
  if (selector === undefined || selector === null) return NON_DELETED;

  if (typeof selector === 'string') {
    const slugs = MEMBERSHIPS[selector] ?? [];
    return NON_DELETED.filter((candidate) => slugs.includes(candidate.slug));
  }

  if (typeof selector === 'object') {
    const principal = selector as { actorType?: unknown; role?: unknown; id?: unknown; userId?: unknown };
    if (principal.actorType === 'agent' || principal.role === 'ADMIN') return NON_DELETED;
    const userId =
      typeof principal.id === 'string'
        ? principal.id
        : typeof principal.userId === 'string'
          ? principal.userId
          : null;
    const slugs = userId ? MEMBERSHIPS[userId] ?? [] : [];
    return NON_DELETED.filter((candidate) => slugs.includes(candidate.slug));
  }

  return NON_DELETED;
}

function createRepoDouble(): RepoDouble {
  const known: RepoDouble = {
    findAll: jest.fn(async (...args: unknown[]) => rowsForSelector(args[0])),
    findAllIds: jest.fn(async () => NON_DELETED.map((p) => ({ id: p.id }))),
    findBySlug: jest.fn(async (slug: string) => ALL_ROWS.find((p) => p.slug === slug) ?? null),
    findByKey: jest.fn(async () => null),
    findMembershipRole: jest.fn(async (projectId: string, userId: string) => {
      const slugs = MEMBERSHIPS[userId];
      const row = ALL_ROWS.find((p) => p.id === projectId);
      return slugs && row && slugs.includes(row.slug) ? 'DEVELOPER' : null;
    }),
    isAgentOnRoster: jest.fn(async (projectId: string, agentId: string) => {
      const slugs = AGENT_ROSTER[agentId] ?? [];
      const row = ALL_ROWS.find((p) => p.id === projectId);
      return row !== undefined && slugs.includes(row.slug);
    }),
    findAllForAgent: jest.fn(async (agentId: string) => {
      const slugs = AGENT_ROSTER[agentId] ?? [];
      return NON_DELETED.filter((candidate) => slugs.includes(candidate.slug));
    }),
  };

  return new Proxy(known, {
    get(target: RepoDouble, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      // Never fabricate a thenable: `await` on the double would otherwise hang.
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      if (!(prop in target)) {
        target[prop] = /deleted|include|raw|unscoped/i.test(prop)
          ? jest.fn(async () => ALL_ROWS)
          : jest.fn(async (...args: unknown[]) => rowsForSelector(args[0]));
      }
      return target[prop];
    },
  });
}

const MEMBER_PRINCIPAL: UserPrincipal = {
  actorType: 'user',
  id: 'user-multi',
  sub: 'user-multi',
  name: 'multi',
  email: 'multi@koda.test',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
};

const NON_MEMBER_PRINCIPAL: UserPrincipal = {
  ...MEMBER_PRINCIPAL,
  id: 'user-nobody',
  sub: 'user-nobody',
  name: 'nobody',
  email: 'nobody@koda.test',
};

const ADMIN_PRINCIPAL: UserPrincipal = {
  ...MEMBER_PRINCIPAL,
  id: 'user-admin',
  sub: 'user-admin',
  name: 'admin',
  email: 'admin@koda.test',
  role: 'ADMIN',
  authorities: ['ADMIN'],
};

const AGENT_PRINCIPAL: AgentPrincipal = {
  actorType: 'agent',
  id: 'agent-1',
  sub: 'agent-1',
  slug: 'bot',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
  name: 'Bot',
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};

const slugsOf = (projects: { slug: string }[]): string[] => projects.map((p) => p.slug).sort();

describe('ProjectsService.findAllForPrincipal (US-002)', () => {
  let repo: RepoDouble;
  let service: ProjectsService;

  beforeEach(() => {
    repo = createRepoDouble();
    service = new ProjectsService(
      repo as unknown as PrismaProjectRepository,
      {
        deleteAllBySourceType: jest.fn(),
        clearProjectCaches: jest.fn(),
      } as unknown as RagService,
      undefined,
      new ProjectAccessService(repo as unknown as PrismaProjectRepository),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('AC6: returns exactly the projects a user principal is a member of', async () => {
    const projects = await service.findAllForPrincipal(MEMBER_PRINCIPAL);

    expect(slugsOf(projects)).toEqual(['alpha', 'bravo']);
  });

  it('AC6 boundary: returns no project for a user principal with no membership row', async () => {
    const projects = await service.findAllForPrincipal(NON_MEMBER_PRINCIPAL);

    expect(projects).toEqual([]);
  });

  it('AC7: returns every non-deleted project for a global ADMIN user principal', async () => {
    const projects = await service.findAllForPrincipal(ADMIN_PRINCIPAL);

    expect(slugsOf(projects)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('AC11 (S4c US-001): returns exactly the agent roster projects, never a soft-deleted one', async () => {
    const projects = await service.findAllForPrincipal(AGENT_PRINCIPAL);

    expect(slugsOf(projects)).toEqual(['alpha', 'bravo']);
    // `delta` is on the roster but soft-deleted: the roster never resurrects it.
    expect(slugsOf(projects)).not.toContain('delta');
    expect(repo.findAllForAgent).toHaveBeenCalledWith('agent-1');
  });

  it('AC12 (S4c US-001): with scoping off an agent gets every non-deleted project', async () => {
    const unscoped = new ProjectsService(
      repo as unknown as PrismaProjectRepository,
      {
        deleteAllBySourceType: jest.fn(),
        clearProjectCaches: jest.fn(),
      } as unknown as RagService,
      undefined,
      new ProjectAccessService(repo as unknown as PrismaProjectRepository, {
        agentProjectScoping: false,
      } as never),
    );

    const projects = await unscoped.findAllForPrincipal(AGENT_PRINCIPAL);

    expect(slugsOf(projects)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(repo.findAllForAgent).not.toHaveBeenCalled();
  });

  it('AC9: never returns a soft-deleted project, even for a member of it', async () => {
    const projects = await service.findAllForPrincipal(MEMBER_PRINCIPAL);

    expect(slugsOf(projects)).not.toContain('delta');
    expect(slugsOf(projects)).toEqual(['alpha', 'bravo']);
  });

  it('AC9 boundary: a soft-deleted project is absent for a global ADMIN user principal too', async () => {
    const projects = await service.findAllForPrincipal(ADMIN_PRINCIPAL);

    expect(slugsOf(projects)).not.toContain('delta');
  });
});
