import { Test, type TestingModule } from '@nestjs/testing';
import type { UserPrincipal } from '../../../auth/principal/koda-principal.types';
import type { ProjectDomain } from '../../../projects/domain/project.domain';
import type { ProjectAccessService } from '../../../projects/project-access.service';
import { ProjectsService } from '../../../projects/projects.service';
import { KodaCaslAbilityFactory } from '../../../auth/casl/koda-casl-ability.factory';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import type { ToolContext } from '../assistant-tool.types';
import { KODA_MY_PROJECTS } from '../koda-tool-descriptors';
import {
  PROJECT_COUNTS_READER,
  type AssistantToolCallRecord,
  type AssistantToolCallRepository,
  type ProjectCounts,
  type ProjectCountsReader,
  type ToolCallContext,
} from '../assistant-tool-call.domain';
import { WorkspaceTools, myProjectsTool } from './workspace-tools';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-15T12:00:00.000Z');

const actor: UserPrincipal = {
  actorType: 'user', id: 'u1', name: 'u1@koda.test', email: 'u1@koda.test', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'], extra: {},
};

/** The real escape hatch answers zeros for a project with no rows; the stubs follow the same shape. */
const countsOf = (entries: Record<string, Partial<ProjectCounts>> = {}): Map<string, ProjectCounts> =>
  new Map(Object.entries(entries).map(([id, c]) => [id, { openTickets: 0, failedJobs7d: 0, pendingApprovals: 0, ...c }]));

function project(slug: string, name = `Project ${slug}`): ProjectDomain {
  return {
    id: `id-${slug}`, name, slug, key: slug.toUpperCase(), description: null, gitRemoteUrl: null,
    autoIndexOnClose: true, autoAssign: 'OFF', graphifyEnabled: false, graphifyLastImportedAt: null,
    ciWebhookToken: null, deletedAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

const projectsOf = (projects: ProjectDomain[]) =>
  ({ findAllForPrincipal: vi.fn(async () => projects) }) as unknown as ProjectsService;

const readerOf = (counts: Map<string, ProjectCounts> = countsOf()) =>
  ({ findProjectCounts: vi.fn(async () => counts) }) as unknown as ProjectCountsReader;

/** Every user-written field goes through `ctx.data`; the stub makes the wrap visible in the output. */
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  projectId: 'home-id', projectSlug: 'home', actor, threadId: 't1', jobId: 'j1', now: NOW,
  data: (text) => `<<${text}>>`,
  ...over,
});

const lines = (slug: string): RegExp => new RegExp(`^${slug} open_tickets: \\d+ failed_jobs_7d: \\d+ pending_approvals: \\d+ /${slug}$`);

describe('koda_my_projects (US-003)', () => {
  it('AC-8: the project name goes through ctx.data under its own project line', async () => {
    const tool = myProjectsTool(projectsOf([project('a', 'Alpha')]), readerOf());

    const content = await tool.execute(ctx(), {});

    expect(content.split('\n')).toEqual(['a open_tickets: 0 failed_jobs_7d: 0 pending_approvals: 0 /a', '<<Alpha>>']);
  });

  it('AC-3, AC-4 and AC-5: the line carries the three counts the reader answered', async () => {
    const tool = myProjectsTool(projectsOf([project('a')]), readerOf(countsOf({ 'id-a': { openTickets: 4, failedJobs7d: 2, pendingApprovals: 1 } })));

    expect((await tool.execute(ctx(), {})).split('\n')[0]).toBe('a open_tickets: 4 failed_jobs_7d: 2 pending_approvals: 1 /a');
  });

  it('asks the reader once for the listed projects and the 7-day window that ends at ctx.now', async () => {
    const reader = readerOf();
    const tool = myProjectsTool(projectsOf([project('b'), project('a')]), reader);

    await tool.execute(ctx(), {});

    expect(reader.findProjectCounts).toHaveBeenCalledTimes(1);
    const [ids, failedSince] = (reader.findProjectCounts as unknown as { mock: { calls: [string[], Date][] } }).mock.calls[0];
    expect([...ids].sort()).toEqual(['id-a', 'id-b']);
    expect(failedSince).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
  });

  it('lists the projects by slug ascending, not in the order the service answered them', async () => {
    const tool = myProjectsTool(projectsOf([project('b-two'), project('a-one')]), readerOf());

    const content = await tool.execute(ctx(), {});

    expect(content.split('\n')[0]).toMatch(lines('a-one'));
    expect(content.split('\n')[2]).toMatch(lines('b-two'));
  });

  it('AC-9: 51 reachable projects answer 50 project lines then the overflow line', async () => {
    const many = Array.from({ length: 51 }, (_, i) => project(`p${String(i).padStart(2, '0')}`));
    const tool = myProjectsTool(projectsOf(many), readerOf());

    const content = await tool.execute(ctx(), {});
    const rows = content.split('\n');
    const projectRows = rows.filter((row) => row.includes(' open_tickets: '));

    expect(projectRows).toHaveLength(50);
    expect(projectRows[0]).toMatch(lines('p00'));
    expect(projectRows[49]).toMatch(lines('p49'));
    expect(content).not.toContain('p50');
    expect(rows[rows.length - 1]).toBe('more: 1 projects not listed');
  });

  it('AC-10: no reachable project answers no projects', async () => {
    const reader = readerOf();
    const tool = myProjectsTool(projectsOf([]), reader);

    expect(await tool.execute(ctx(), {})).toBe('no projects');
    expect(reader.findProjectCounts).not.toHaveBeenCalled();
  });

  it('takes no input and is the one workspace-scoped tool', async () => {
    const tool = myProjectsTool(projectsOf([]), readerOf());

    expect(tool.descriptor).toBe(KODA_MY_PROJECTS);
    expect(tool.scope).toBe('workspace');
    expect(tool.parse({})).toEqual({});
    expect(tool.parse({ anything: 1 })).toEqual({});
  });
});

describe('WorkspaceTools (US-003)', () => {
  let module: TestingModule;
  let registry: AssistantToolRegistry;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        WorkspaceTools,
        AssistantToolRegistry,
        { provide: ProjectsService, useValue: projectsOf([]) },
        { provide: PROJECT_COUNTS_READER, useValue: readerOf() },
      ],
    }).compile();
    await module.init();
    registry = module.get(AssistantToolRegistry);
  });

  afterAll(async () => {
    await module.close();
  });

  it('AC-14: registers koda_my_projects with KODA_MY_PROJECTS and scope workspace', () => {
    const tool = registry.get('koda_my_projects');

    expect(tool).toBeDefined();
    expect(tool?.descriptor).toBe(KODA_MY_PROJECTS);
    expect(tool?.scope).toBe('workspace');
  });
});

describe('koda_my_projects through the executor (US-003)', () => {
  const creator = { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false };
  const context: ToolCallContext = {
    project: { id: 'home-id', slug: 'home' }, threadId: 't1', creator, kind: 'WORKSPACE',
  };

  it('AC-11: a workspace-scoped call runs the tool with no membership or project lookup', async () => {
    const rows: AssistantToolCallRecord[] = [];
    const repo: AssistantToolCallRepository = {
      findUserActor: vi.fn(async () => null),
      findByCall: vi.fn(async () => null),
      record: vi.fn(async (row) => { rows.push(row); }),
      findCallContext: vi.fn(async () => context),
    };
    const access = { findProjectIdBySlug: vi.fn(), resolveMembership: vi.fn() };
    const registry = new AssistantToolRegistry();
    registry.register(myProjectsTool(projectsOf([project('a')]), readerOf()));
    const executor = new AssistantToolExecutor(
      registry, repo, access as unknown as ProjectAccessService, new KodaCaslAbilityFactory(),
    );

    const result = await executor.execute({ jobId: 'j1', toolCallId: 'c1', name: 'koda_my_projects', input: {} });

    expect(result.isError).toBe(false);
    expect(result.content.split('\n')[0]).toMatch(lines('a'));
    expect(access.resolveMembership).not.toHaveBeenCalled();
    expect(access.findProjectIdBySlug).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ projectId: 'home-id', outcome: 'ok', tool: 'koda_my_projects' });
  });
});
