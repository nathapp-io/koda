import { gateDouble } from '../../../test/helpers/assistant-gate-double';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantTool, ToolContext } from './assistant-tool.types';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from './assistant-tool-call.domain';
import type { ProjectAccessService } from '../../projects/project-access.service';
import type { PermissionService } from '../../permissions/permission.service';

type Kind = NonNullable<ToolCallContext['kind']>;

const HOME = { id: 'home-id', slug: 'home' };
const PROJECTS: Record<string, string> = { b: 'b-id', c: 'c-id' };

interface Options {
  kind?: Kind;
  creatorRole?: string;
  roles?: Record<string, string | undefined>;
  omitKind?: boolean;
}

function setup(tool: AssistantTool<unknown>, opts: Options = {}) {
  const rows: AssistantToolCallRecord[] = [];
  const ctx: ToolCallContext = {
    project: HOME,
    threadId: 't1',
    creator: { id: 'u1', email: 'u1@koda.test', role: opts.creatorRole ?? 'MEMBER', disabled: false },
    ...(opts.omitKind ? {} : { kind: opts.kind ?? 'WORKSPACE' }),
  };
  const repo: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async (jobId, toolCallId) => rows.find((r) => r.jobId === jobId && r.toolCallId === toolCallId) ?? null),
    record: vi.fn(async (row) => { rows.push(row); }),
    findCallContext: vi.fn(async () => ctx),
  };
  const roles = { ...opts.roles };
  const access = {
    findProjectIdBySlug: vi.fn(async (slug: string) => {
      const id = PROJECTS[slug];
      if (!id) throw new NotFoundAppException({}, 'projects');
      return id;
    }),
    resolveMembership: vi.fn(async (projectId: string) => {
      const slug = Object.keys(PROJECTS).find((s) => PROJECTS[s] === projectId) ?? 'home';
      const role = slug in roles ? roles[slug] : 'DEVELOPER';
      if (role === undefined) throw new ForbiddenAppException({}, 'projects');
      return role;
    }),
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  // Permissions P1 US-004: the tool's key is a `PermissionService` read now; every key is allowed here, so each case
  // stays about the project argument and the resolved scope.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const executor = new AssistantToolExecutor(registry, repo, access as unknown as ProjectAccessService, permissions, ...gateDouble().deps);
  return { executor, rows, access, roles, permissions };
}

function makeTool(over: Partial<AssistantTool<unknown>> = {}): AssistantTool<unknown> {
  return {
    descriptor: { name: 'koda_search_tickets', description: 'd', inputSchema: {} },
    key: 'ticket.read',
    parse: vi.fn((input: unknown) => input),
    execute: vi.fn(async () => 'tool text'),
    ...over,
  };
}

const call = (input: unknown, over: Partial<{ toolCallId: string; name: string }> = {}) => ({
  jobId: 'j1', toolCallId: 'c1', name: 'koda_search_tickets', input, ...over,
});

const INVALID_PROJECT = { content: 'invalid_input: project', isError: true };
const NO_PROJECT = { content: 'not_found: project', isError: true };

describe('S5b-R7 project argument: REPO and PROJECT threads refuse it', () => {
  it('AC-1: a REPO thread call with a project key answers invalid_input: project and never runs the tool', async () => {
    const tool = makeTool();
    const { executor } = setup(tool, { kind: 'REPO' });
    expect(await executor.execute(call({ project: 'web' }))).toEqual(INVALID_PROJECT);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(tool.parse).not.toHaveBeenCalled();
  });

  it('AC-2: a PROJECT thread call with a project key answers invalid_input: project', async () => {
    const { executor } = setup(makeTool(), { kind: 'PROJECT' });
    expect(await executor.execute(call({ project: 'web', text: 'x' }))).toEqual(INVALID_PROJECT);
  });

  it('a context with no kind reads as REPO and refuses a project key', async () => {
    const { executor } = setup(makeTool(), { omitKind: true });
    expect(await executor.execute(call({ project: 'web' }))).toEqual(INVALID_PROJECT);
  });

  it('a REPO call without a project key keeps the home project path', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'ok'; } });
    const { executor, access } = setup(tool, { kind: 'REPO' });
    expect(await executor.execute(call({ text: 'x' }))).toEqual({ content: 'ok', isError: false });
    expect(seen).toMatchObject({ projectId: 'home-id', projectSlug: 'home' });
    expect(access.findProjectIdBySlug).not.toHaveBeenCalled();
  });

  it('a non-object input has no project key and reaches the tool parser', async () => {
    const tool = makeTool();
    const { executor } = setup(tool, { kind: 'REPO' });
    await executor.execute(call(null));
    expect(tool.parse).toHaveBeenCalledWith(null);
  });
});

describe('S5b-R7 project argument: WORKSPACE threads validate it', () => {
  it('AC-3: a missing project answers invalid_input: project', async () => {
    const { executor, access } = setup(makeTool());
    expect(await executor.execute(call({}))).toEqual(INVALID_PROJECT);
    expect(access.findProjectIdBySlug).not.toHaveBeenCalled();
  });

  it.each([[null], [[]], ['b'], [7]])('a non-object input %j answers invalid_input: project', async (input) => {
    const { executor } = setup(makeTool());
    expect(await executor.execute(call(input))).toEqual(INVALID_PROJECT);
  });

  it('a non-string project answers invalid_input: project', async () => {
    const { executor } = setup(makeTool());
    expect(await executor.execute(call({ project: 5 }))).toEqual(INVALID_PROJECT);
  });

  it('AC-4: a project that is not a slug answers invalid_input: project with no lookup', async () => {
    const { executor, access } = setup(makeTool());
    expect(await executor.execute(call({ project: 'Not A Slug' }))).toEqual(INVALID_PROJECT);
    expect(access.findProjectIdBySlug).not.toHaveBeenCalled();
    expect(access.resolveMembership).not.toHaveBeenCalled();
  });

  /**
   * The project slug contract (`CreateProjectDto.slug`) has no length bound; the descriptor's `maxLength: 100` is
   * guidance for the model, not a refusal the executor may invent. A longer slug matching the pattern is looked up.
   */
  it('M1: a slug longer than the descriptor maxLength is looked up instead of refused', async () => {
    const longSlug = 'a'.repeat(101);
    const tool = makeTool();
    const { executor, access } = setup(tool);
    expect(await executor.execute(call({ project: longSlug }))).toEqual(NO_PROJECT);
    expect(access.findProjectIdBySlug).toHaveBeenCalledWith(longSlug);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('AC-5: parse gets the input without project, execute gets the resolved project', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'ok'; } });
    const { executor } = setup(tool);
    const input = { project: 'b', text: 'x' };
    expect(await executor.execute(call(input))).toEqual({ content: 'ok', isError: false });
    expect(tool.parse).toHaveBeenCalledWith({ text: 'x' });
    expect(seen).toMatchObject({ projectId: 'b-id', projectSlug: 'b' });
    expect(input).toEqual({ project: 'b', text: 'x' });
  });

  it('the key check uses the caller principal for the resolved project', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'ok'; } });
    const { executor, access, permissions } = setup(tool, { roles: { b: 'VIEWER' } });
    await executor.execute(call({ project: 'b' }));
    expect(access.resolveMembership).toHaveBeenCalledWith('b-id', expect.objectContaining({ id: 'u1' }));
    expect(permissions.can).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'ticket.read', { projectId: 'b-id' });
    // US-004: the resolved role admits the call; it does not decorate the actor the tool receives.
    expect(seen?.actor).toMatchObject({ id: 'u1', actorType: 'user' });
    expect(Object.prototype.hasOwnProperty.call(seen?.actor, 'projectRole')).toBe(false);
  });

  it('AC-10: an unknown slug answers not_found: project and no row names the lookup', async () => {
    const tool = makeTool();
    const { executor, access, rows } = setup(tool);
    expect(await executor.execute(call({ project: 'nope' }))).toEqual(NO_PROJECT);
    expect(access.resolveMembership).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ outcome: 'not_found', projectId: 'home-id' });
  });

  it('AC-9 and AC-11: a project the creator is not a member of answers the same not_found: project', async () => {
    const { executor, rows } = setup(makeTool(), { roles: { b: undefined } });
    expect(await executor.execute(call({ project: 'b' }))).toEqual(NO_PROJECT);
    expect(rows[0]).toMatchObject({ outcome: 'not_found', projectId: 'home-id' });
  });

  it('AC-12: a global ADMIN reaches a project without a member row', async () => {
    const { executor, access } = setup(makeTool(), { creatorRole: 'ADMIN', roles: { c: 'ADMIN' } });
    expect((await executor.execute(call({ project: 'c' }))).isError).toBe(false);
    expect(access.resolveMembership).toHaveBeenCalledWith('c-id', expect.objectContaining({ role: 'ADMIN' }));
  });

  it('AC-13: membership is resolved on every call, never cached', async () => {
    const { executor, roles } = setup(makeTool());
    expect((await executor.execute(call({ project: 'b' }, { toolCallId: 'c1' }))).isError).toBe(false);
    roles['b'] = undefined;
    expect(await executor.execute(call({ project: 'b' }, { toolCallId: 'c2' }))).toEqual(NO_PROJECT);
  });

  it('AC-7: the stored row carries the resolved project id', async () => {
    const { executor, rows } = setup(makeTool());
    await executor.execute(call({ project: 'b' }));
    expect(rows[0]).toMatchObject({ projectId: 'b-id', outcome: 'ok' });
  });

  it('AC-14 (US-004): a key the creator does not hold in b is refused, naming b, and the tool never runs', async () => {
    const tool = makeTool({ key: 'fleet.job.dispatch' });
    const { executor, rows, permissions } = setup(tool, { roles: { b: 'VIEWER' } });
    vi.mocked(permissions.can).mockImplementation(async (_actor: unknown, key: string) => ({ allowed: key !== 'fleet.job.dispatch', reason: 'granted' }));

    const result = await executor.execute(call({ project: 'b' }));

    expect(result.isError).toBe(true);
    expect(result.content).toBe('forbidden: koda_search_tickets needs fleet.job.dispatch on b');
    expect(tool.execute).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ outcome: 'forbidden', projectId: 'b-id' });
    // The key is asked in the project the call resolved, never the thread's home project, and for the
    // caller's own principal (US-004: the resolved role no longer decorates it).
    const [checkedActor] = vi.mocked(permissions.can).mock.calls.at(-1) ?? [];
    expect(checkedActor).toMatchObject({ id: 'u1' });
    expect(Object.prototype.hasOwnProperty.call(checkedActor, 'projectRole')).toBe(false);
    expect(vi.mocked(permissions.can).mock.calls.at(-1)?.[2]).toEqual({ projectId: 'b-id' });
  });

});

describe('1d2-D3 and 1d2-D5: workspace-scoped tools', () => {
  const workspaceTool = (over: Partial<AssistantTool<unknown>> = {}) =>
    makeTool({ descriptor: { name: 'koda_ws', description: 'd', inputSchema: {} }, scope: 'workspace', ...over });
  const wsCall = (input: unknown) => call(input, { name: 'koda_ws' });

  it('step 1: a REPO thread refuses a workspace-scoped tool', async () => {
    const tool = workspaceTool();
    const { executor } = setup(tool, { kind: 'REPO' });
    expect(await executor.execute(wsCall({}))).toEqual({ content: 'invalid_input: koda_ws is only available in workspace threads', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('step 1: a PROJECT thread refuses a workspace-scoped tool', async () => {
    const { executor } = setup(workspaceTool(), { kind: 'PROJECT' });
    expect((await executor.execute(wsCall({}))).content).toContain('only available in workspace threads');
  });

  it('step 2: a workspace-scoped tool refuses a project key in a WORKSPACE thread', async () => {
    const { executor } = setup(workspaceTool());
    expect(await executor.execute(wsCall({ project: 'b' }))).toEqual(INVALID_PROJECT);
  });

  it('runs with no membership or key check and the home project context', async () => {
    let seen: ToolContext | undefined;
    const tool = workspaceTool({
      execute: async (ctx: ToolContext) => { seen = ctx; return 'ok'; },
    });
    const { executor, access, rows, permissions } = setup(tool);
    expect(await executor.execute(wsCall({}))).toEqual({ content: 'ok', isError: false });
    expect(access.resolveMembership).not.toHaveBeenCalled();
    expect(access.findProjectIdBySlug).not.toHaveBeenCalled();
    // US-004: a workspace-scope tool takes no key check; the listing is the caller's reachable projects, as before.
    expect(permissions.can).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ projectId: 'home-id', projectSlug: 'home', actor: { id: 'u1' } });
    expect(Object.prototype.hasOwnProperty.call(seen?.actor, 'projectRole')).toBe(false);
    expect(rows[0]).toMatchObject({ projectId: 'home-id' });
  });
});
