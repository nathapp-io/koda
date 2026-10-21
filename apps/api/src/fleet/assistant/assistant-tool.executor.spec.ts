import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ProjectAccessService } from '../../projects/project-access.service';
import { AssistantActionService } from './actions/assistant-action.service';
import type { PendingActionRecord, ProposeInput, ProposeResult } from './actions/pending-action.domain';
import { AssistantModule } from './assistant.module';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { ToolInputError, type AssistantTool, type ToolContext } from './assistant-tool.types';
import { ASSISTANT_TOOL_CALL_REPOSITORY, type AssistantToolCallRecord, type AssistantToolCallRepository, type ToolCallContext } from './assistant-tool-call.domain';
import type { PermissionService } from '../../permissions/permission.service';
import { stableStringify } from '../sync/stable-json';

const GHP = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;

const context = (over: Partial<ToolCallContext['creator']> = {}): ToolCallContext => ({
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false, ...over },
});

/**
 * The repository stub. 3-D12: `checkAction`/`executeAction` resolve the requester through `findUserActor`, so it
 * answers the same user the call-context stub carries — the thread creator every action fixture here names — unless
 * `actor` overrides it.
 */
function makeRepo(ctx: ToolCallContext | null, actor: ToolCallContext['creator'] | null = ctx?.creator ?? null) {
  const rows: AssistantToolCallRecord[] = [];
  const repo: AssistantToolCallRepository = {
    findUserActor: vi.fn(async (userId: string) => (actor?.id === userId ? actor : null)),
    findByCall: vi.fn(async (jobId, toolCallId) => rows.find((r) => r.jobId === jobId && r.toolCallId === toolCallId) ?? null),
    record: vi.fn(async (row) => { rows.push(row); }),
    findCallContext: vi.fn(async () => ctx),
  };
  return { repo, rows };
}

/**
 * A `PermissionService` double (permissions P1 US-004): every key is allowed, except the ones named in `refused`.
 * The real decision is asserted in the executor's DB-backed specs; here the double is what tells the executor's
 * key check apart from its membership check.
 */
function permissionDouble(refused: readonly string[] = []) {
  return {
    can: vi.fn(async (_actor: unknown, key: string) => ({ allowed: !refused.includes(key), reason: 'granted' })),
  };
}

type PermissionsDouble = ReturnType<typeof permissionDouble>;

function makeTool(over: Partial<AssistantTool<string>> = {}): AssistantTool<string> {
  return {
    descriptor: { name: 'koda_fake', description: 'd', inputSchema: {} },
    key: 'ticket.read',
    parse: (input) => String(input),
    execute: vi.fn(async () => 'tool text'),
    ...over,
  };
}

/** The slugs a WORKSPACE thread's `project` argument can resolve to; anything else is a soft-deleted or unknown project. */
const PROJECT_IDS: Record<string, string> = { web: 'p1', b: 'p2' };

interface SetupOptions {
  creator?: Partial<ToolCallContext['creator']>;
  role?: string | null;
  membership?: Error;
  kind?: ToolCallContext['kind'];
  /** The permission decision the executor's key checks read (permissions P1 US-004); every key is allowed by default. */
  permissions?: PermissionsDouble;
  /** The action's actor cannot be read at all (`findUserActor` answers null, as it does for a deleted user). */
  noActor?: boolean;
}

interface Setup {
  executor: AssistantToolExecutor;
  rows: AssistantToolCallRecord[];
  repo: AssistantToolCallRepository;
  access: { findProjectIdBySlug: ReturnType<typeof vi.fn>; resolveMembership: ReturnType<typeof vi.fn> };
  permissions: PermissionsDouble;
}

function setup(tool: AssistantTool<unknown> | null, opts: SetupOptions = {}): Setup {
  const { repo, rows } = makeRepo({ ...context(opts.creator), ...(opts.kind ? { kind: opts.kind } : {}) }, opts.noActor ? null : undefined);
  const access = {
    findProjectIdBySlug: vi.fn(async (slug: string) => {
      const id = PROJECT_IDS[slug];
      if (!id) throw new NotFoundAppException({}, 'projects');
      return id;
    }),
    resolveMembership: vi.fn(async () => {
      if (opts.membership) throw opts.membership;
      return opts.role === undefined ? 'DEVELOPER' : opts.role;
    }),
  };
  const registry = new AssistantToolRegistry();
  if (tool) registry.register(tool as AssistantTool);
  const permissions = opts.permissions ?? permissionDouble();
  const executor = new AssistantToolExecutor(
    registry, repo, access as unknown as ProjectAccessService, permissions as unknown as PermissionService,
  );
  return { executor, rows, repo, access, permissions };
}

const call = (over: Partial<{ jobId: string; toolCallId: string; name: string; input: unknown }> = {}) => ({
  jobId: 'j1', toolCallId: 'c1', name: 'koda_fake', input: { ref: 'WEB-1' }, ...over,
});

/**
 * 2a-D8: one stored action. Its project (`p2`/`ops`) is deliberately not the thread's home project (`p1`/`web`),
 * so the context the executor builds for an approve can be told apart from the proposing call's (AC-21).
 */
const pendingAction = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: 'u1', origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
  id: 'a1', projectId: 'p2', projectSlug: 'ops', threadId: 't1', jobId: 'j1', toolCallId: 'c1', tool: 'koda_fake',
  input: { ref: 'OPS-1' }, preview: 'Add a comment to OPS-1 "Fix"', status: 'PENDING',
  approvalId: 'ap1', decidedAt: null, result: null, deliveredAt: null,
  expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'), ...over,
});

describe('AssistantToolExecutor', () => {
  it('AC-1: a member tool for a DEVELOPER creator returns the tool text', async () => {
    const { executor } = setup(makeTool());
    expect(await executor.execute(call())).toEqual({ content: 'tool text', isError: false });
  });

  it('AC-2: an unknown tool name throws NotFoundAppException with the fleet.assistantTool key', async () => {
    const { executor } = setup(makeTool());
    const error = await executor.execute(call({ name: 'koda_nope' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundAppException);
    expect(JSON.stringify(error)).toContain('fleet.assistantTool');
  });

  it('AC-3 and AC-19: a parse rejection answers invalid_input and never executes the tool', async () => {
    const tool = makeTool({ parse: () => { throw new ToolInputError('ref'); } });
    const { executor } = setup(tool);
    expect(await executor.execute(call())).toEqual({ content: 'invalid_input: ref', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('AC-4 and AC-16: a non-member creator is refused, the tool is not run and the row records forbidden', async () => {
    const tool = makeTool();
    const { executor, rows } = setup(tool, { membership: new ForbiddenAppException({}, 'projects') });
    expect(await executor.execute(call())).toEqual({ content: 'forbidden: koda_fake needs project membership on web', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'forbidden', isError: true, tool: 'koda_fake' });
  });

  it('AC-5: a disabled creator is refused', async () => {
    const tool = makeTool();
    const { executor } = setup(tool, { creator: { disabled: true } });
    expect(await executor.execute(call())).toEqual({ content: 'forbidden: the thread creator is disabled', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('AC-4 (US-004): a tool whose key is refused answers forbidden: <tool> needs <key> on <slug> and never runs', async () => {
    const tool = makeTool({ key: 'fleet.job.dispatch' });
    const { executor, permissions } = setup(tool, { permissions: permissionDouble(['fleet.job.dispatch']) });

    expect(await executor.execute(call())).toEqual({ content: 'forbidden: koda_fake needs fleet.job.dispatch on web', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
    // The check asks about the tool's own catalog key, in the project the call acts in.
    expect(permissions.can).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'fleet.job.dispatch', { projectId: 'p1' });
  });

  it('also asks for the key of a member tool, so a member-only tool is not a bypass', async () => {
    const tool = makeTool({ key: 'ticket.read' });
    const { executor } = setup(tool, { permissions: permissionDouble(['ticket.read']) });

    expect(await executor.execute(call())).toEqual({ content: 'forbidden: koda_fake needs ticket.read on web', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('runs the same keyed tool for a creator the permission service allows', async () => {
    const tool = makeTool({ key: 'fleet.job.dispatch' });
    const { executor } = setup(tool, { role: 'DEVELOPER' });
    expect((await executor.execute(call())).isError).toBe(false);
  });

  it('AC-4: a global reader with MEMBER role and no ProjectMember row runs a member tool', async () => {
    const { executor, access } = setup(makeTool(), { creator: { role: 'MEMBER' }, role: 'ADMIN' });
    expect((await executor.execute(call())).isError).toBe(false);
    expect(access.resolveMembership).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'u1', role: 'MEMBER' }));
  });

  it('AC-8: a tool raising NotFoundAppException answers not_found', async () => {
    const tool = makeTool({ execute: async () => { throw new NotFoundAppException({}, 'tickets'); } });
    const { executor, rows } = setup(tool);
    expect(await executor.execute(call())).toEqual({ content: 'not_found', isError: true });
    expect(rows[0]?.outcome).toBe('not_found');
  });

  it('AC-9 and AC-18: an unexpected error answers error: <tool> failed and is logged with the job id', async () => {
    const tool = makeTool({ execute: async () => { throw new Error('db down'); } });
    const { executor, rows } = setup(tool);
    const logged = vi.spyOn(Logger.prototype, 'error');
    logged.mockClear();
    const result = await executor.execute(call());
    expect(result).toEqual({ content: 'error: koda_fake failed', isError: true });
    expect(result.content).not.toContain('db down');
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain('j1');
    expect(rows[0]?.outcome).toBe('error');
  });

  it('AC-10: ctx.data masks secrets and fences the text', async () => {
    const tool = makeTool({ execute: async (ctx: ToolContext) => ctx.data(`secret ${GHP}`) });
    const { executor } = setup(tool);
    const { content } = await executor.execute(call());
    expect(content).toContain('<<koda-data-');
    expect(content).toContain('[masked]');
    expect(content).not.toContain('ghp_');
  });

  it('AC-10: each call gets a fresh 16-hex fence token', async () => {
    const tool = makeTool({ execute: async (ctx: ToolContext) => ctx.data('x') });
    const { executor } = setup(tool);
    const a = (await executor.execute(call({ toolCallId: 'a' }))).content.match(/<<koda-data-([0-9a-f]{16})>>/)?.[1];
    const b = (await executor.execute(call({ toolCallId: 'b' }))).content.match(/<<koda-data-([0-9a-f]{16})>>/)?.[1];
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('passes the project, thread, actor and job to the tool context', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'ok'; } });
    const { executor } = setup(tool, { role: 'DEVELOPER' });
    await executor.execute(call());
    expect(seen).toMatchObject({ projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', actor: { id: 'u1', actorType: 'user' } });
  });

  it('AC-9 (US-004): a project tool runs with the caller principal itself, which carries no projectRole property', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'ok'; } });
    const { executor, access, permissions } = setup(tool, { role: 'DEVELOPER' });

    await executor.execute(call());

    // The membership was resolved (the caller is admitted)…
    expect(access.resolveMembership).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'u1' }));
    // …but the actor the tool receives is the principal as it is, with no role decorating it.
    expect(seen?.actor).toMatchObject({ id: 'u1', actorType: 'user' });
    expect(Object.prototype.hasOwnProperty.call(seen?.actor, 'projectRole')).toBe(false);
    // The key check reads the same undecorated principal.
    expect(Object.prototype.hasOwnProperty.call(permissions.can.mock.calls[0]?.[0], 'projectRole')).toBe(false);
  });

  it('AC-11: a 40000-byte result is capped to 16384 bytes and ends with [truncated]', async () => {
    const line = `${'x'.repeat(79)}\n`;
    const tool = makeTool({ execute: async () => line.repeat(Math.ceil(40000 / line.length)).slice(0, 40000) });
    const { executor, rows } = setup(tool);
    const { content } = await executor.execute(call());
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(16384);
    expect(content.endsWith('[truncated]')).toBe(true);
    expect(rows[0]?.resultBytes).toBe(Buffer.byteLength(content));
  });

  it('stores the hash of the raw input, never the input', async () => {
    const { executor, rows } = setup(makeTool());
    await executor.execute(call({ input: { b: 1, a: { d: 2, c: 3 } } }));
    expect(rows[0]?.inputHash).toBe(createHash('sha256').update(stableStringify({ b: 1, a: { d: 2, c: 3 } })).digest('hex'));
    expect(JSON.stringify(rows[0])).not.toContain('"d":2');
  });

  it('AC-17: a stored toolCallId reused with another tool answers toolCallId reused and stores nothing new', async () => {
    const { executor, rows } = setup(makeTool());
    await executor.execute(call());
    const other = makeTool({ descriptor: { name: 'koda_other', description: 'd', inputSchema: {} } });
    const second = setup(other);
    second.rows.push(...rows);
    expect(await second.executor.execute(call({ name: 'koda_other' }))).toEqual({ content: 'invalid_input: toolCallId reused', isError: true });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.tool).toBe('koda_fake');
  });

  it('replays a stored result without running anything else', async () => {
    const tool = makeTool();
    const { executor, access } = setup(tool);
    await executor.execute(call());
    access.resolveMembership.mockClear();
    expect(await executor.execute(call())).toEqual({ content: 'tool text', isError: false });
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(access.resolveMembership).not.toHaveBeenCalled();
  });

  it('answers the stored result when the insert loses a unique-violation race', async () => {
    const tool = makeTool();
    const { repo, rows } = setup(tool);
    const { Prisma } = await import('../../generated/prisma/client');
    const winner: AssistantToolCallRecord = { actorType: 'user', actorId: 'u1', jobId: 'j1', threadId: 't1', projectId: 'p1', toolCallId: 'c1', tool: 'koda_fake', inputHash: createHash('sha256').update(stableStringify(call().input)).digest('hex'), outcome: 'ok', content: 'winner', isError: false, resultBytes: 6, durationMs: 1 };
    let lookups = 0;
    repo.findByCall = vi.fn(async () => (lookups++ === 0 ? null : winner));
    repo.record = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: 'AssistantToolCall_jobId_toolCallId_key' } });
    });
    const registry = new AssistantToolRegistry();
    registry.register(tool as AssistantTool);
    const executor = new AssistantToolExecutor(
      registry, repo, { resolveMembership: async () => 'DEVELOPER' } as unknown as ProjectAccessService,
      permissionDouble() as unknown as PermissionService,
    );
    expect(await executor.execute(call())).toEqual({ content: 'winner', isError: false });
    expect(rows).toHaveLength(0);
  });
});

const PREVIEW = 'Add a comment to WEB-1 "Fix login":\n\nhello';

/** A `kind: 'write'` tool: the executor previews it and proposes, and never calls `execute`. */
function makeWriteTool(over: Partial<AssistantTool<unknown>> = {}): AssistantTool<unknown> {
  return {
    descriptor: { name: 'koda_fake', description: 'd', inputSchema: {} },
    key: 'ticket.read',
    kind: 'write',
    parse: vi.fn((input: unknown) => input),
    preview: vi.fn(async () => PREVIEW),
    execute: vi.fn(async () => 'tool text'),
    ...over,
  };
}

function makeProposer(result: ProposeResult = { actionId: 'a1' }) {
  // 3-D14: the port carries the direct-action record too; this harness serves the propose path only.
  return {
    propose: vi.fn(async (_input: ProposeInput): Promise<ProposeResult> => result),
    recordDirect: vi.fn(async (): Promise<{ actionId: string }> => ({ actionId: 'a1' })),
  };
}

/** A write-tool harness with a proposer attached, as `AssistantActionService.onModuleInit` attaches it (2a-D1). */
function writeSetup(
  over: Partial<AssistantTool<unknown>> = {},
  opts: SetupOptions = {},
  result: ProposeResult = { actionId: 'a1' },
) {
  const tool = makeWriteTool(over);
  const base = setup(tool, opts);
  const proposer = makeProposer(result);
  base.executor.attachActions(proposer);
  return { ...base, tool, proposer };
}

const ACTION_FLEET_JOB: Partial<AssistantTool<unknown>> = { key: 'fleet.job.dispatch' };
/** The harness option of every refused-write case: the dispatch key is not held in `web`. */
const refusedDispatch = (): SetupOptions => ({ permissions: permissionDouble(['fleet.job.dispatch']) });

describe('S5b 2a-D2: a write tool proposes instead of writing', () => {
  it('AC-2: a write tool never calls execute', async () => {
    const { executor, tool } = writeSetup();
    await executor.execute(call());
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('AC-3: preview receives the parsed input and the call context', async () => {
    const parsed = { ref: 'WEB-1', body: 'hello' };
    const { executor, tool } = writeSetup({ parse: vi.fn(() => parsed) });
    await executor.execute(call());
    expect(tool.preview).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1' }), parsed);
  });

  it('AC-4: propose receives the text preview answered as the preview', async () => {
    const preview = vi.fn(async () => 'exactly this preview');
    const { executor, proposer } = writeSetup({ preview });
    await executor.execute(call());
    expect(proposer.propose).toHaveBeenCalledWith(expect.objectContaining({ preview: 'exactly this preview' }));
  });

  it('AC-5, AC-6 and AC-7: a WORKSPACE call proposes in the named project, without the project key, with the thread\'s own kind', async () => {
    const { executor, proposer } = writeSetup({}, { kind: 'WORKSPACE' });
    await executor.execute(call({ input: { project: 'b', text: 'x' } }));
    expect(proposer.propose).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p2', input: { text: 'x' }, threadKind: 'WORKSPACE', threadProjectSlug: 'web',
    }));
  });

  it('AC-8 (US-004): a write tool whose key is refused never previews or proposes', async () => {
    const { executor } = writeSetup(ACTION_FLEET_JOB, refusedDispatch());
    const result = await executor.execute(call());
    expect(result.isError).toBe(true);
    expect(result.content.startsWith('forbidden:')).toBe(true);
  });

  it('AC-18 (US-004): the refusal names the tool, its catalog key and the project slug', async () => {
    const { executor } = writeSetup(ACTION_FLEET_JOB, refusedDispatch());
    expect(await executor.execute(call())).toEqual({ content: 'forbidden: koda_fake needs fleet.job.dispatch on web', isError: true });
  });

  it('AC-9 and AC-19: a refused write tool neither previews nor proposes', async () => {
    const { executor, tool, proposer } = writeSetup(ACTION_FLEET_JOB, refusedDispatch());
    await executor.execute(call());
    expect(tool.preview).not.toHaveBeenCalled();
    expect(proposer.propose).not.toHaveBeenCalled();
  });

  it('AC-10: a preview raising NotFoundAppException answers not_found', async () => {
    const { executor, rows } = writeSetup({ preview: vi.fn(async () => { throw new NotFoundAppException({}, 'tickets'); }) });
    expect(await executor.execute(call())).toEqual({ content: 'not_found', isError: true });
    expect(rows[0]).toMatchObject({ outcome: 'not_found', isError: true });
  });

  it('AC-11: a preview that finds no target proposes nothing', async () => {
    const { executor, proposer } = writeSetup({ preview: vi.fn(async () => { throw new NotFoundAppException({}, 'tickets'); }) });
    await executor.execute(call());
    expect(proposer.propose).not.toHaveBeenCalled();
  });

  it('AC-12 and AC-13: a proposed action answers pending, isError false, and the row records outcome pending', async () => {
    const { executor, rows } = writeSetup();
    expect(await executor.execute(call())).toEqual({ content: 'pending a1: awaiting user approval; do not retry', isError: false });
    expect(rows[0]).toMatchObject({ outcome: 'pending', isError: false, tool: 'koda_fake' });
  });

  it('AC-14: at the per-thread cap the call answers refused', async () => {
    const { executor, rows } = writeSetup({}, {}, { refused: true });
    expect(await executor.execute(call())).toEqual({
      content: 'refused: 10 actions are pending in this thread; wait for the user to decide them', isError: true,
    });
    expect(rows[0]).toMatchObject({ outcome: 'refused', isError: true });
  });

  it('AC-15, AC-20 and AC-21: with no proposer attached a write call is an error, a warning is logged and the row records error', async () => {
    const tool = makeWriteTool({ descriptor: { name: 'w', description: 'd', inputSchema: {} } });
    const { executor, rows } = setup(tool);
    const warned = vi.spyOn(Logger.prototype, 'warn');
    warned.mockClear();
    expect(await executor.execute(call({ name: 'w' }))).toEqual({ content: 'error: w failed', isError: true });
    expect(warned).toHaveBeenCalled();
    expect(String(warned.mock.calls[0]?.[0])).toContain('no action proposer attached');
    expect(rows[0]).toMatchObject({ outcome: 'error', isError: true });
  });

  it('AC-16 and AC-17: a read tool still executes and never proposes', async () => {
    const tool = makeTool();
    const { executor, proposer, rows } = closeOverRead(tool);
    expect(await executor.execute(call())).toEqual({ content: 'tool text', isError: false });
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(proposer.propose).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ outcome: 'ok', isError: false });
  });

  it('an explicit kind: read is a read tool too', async () => {
    const tool = makeTool({ kind: 'read' });
    const { executor, proposer } = closeOverRead(tool);
    await executor.execute(call());
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(proposer.propose).not.toHaveBeenCalled();
  });
});

/** A read tool with a proposer attached: proposing is a write path's job, so nothing may reach it. */
function closeOverRead(tool: AssistantTool<unknown>) {
  const base = setup(tool);
  const proposer = makeProposer();
  base.executor.attachActions(proposer);
  return { ...base, proposer };
}

describe('S5b 2a-D8: checkAction and executeAction', () => {
  it('AC-12: checkAction answers forbidden for a disabled requester', async () => {
    const { executor } = setup(makeTool(), { creator: { disabled: true } });

    expect(await executor.checkAction(pendingAction())).toBe('forbidden');
  });

  it('AC-8 (US-004): checkAction answers forbidden when the requester\'s tool key is refused in the action\'s project', async () => {
    const permissions = permissionDouble(['comment.create']);
    const tool = makeTool({ key: 'comment.create' });
    const { executor } = setup(tool, { permissions });

    expect(await executor.checkAction(pendingAction())).toBe('forbidden');
    // The tool's own catalog key, asked for the requester under the action's project (never the thread's),
    // and for the principal as it is — US-004 stopped decorating it with the project role.
    expect(permissions.can).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'comment.create', { projectId: 'p2' });
    expect(Object.prototype.hasOwnProperty.call(permissions.can.mock.calls[0]?.[0], 'projectRole')).toBe(false);
  });

  it('AC-8 boundary: the same action is approved when the requester holds the key', async () => {
    const tool = makeTool({ key: 'comment.create' });
    const { executor, permissions } = setup(tool);

    expect(await executor.checkAction(pendingAction())).toBe('ok');
    expect(permissions.can).toHaveBeenCalledWith(expect.anything(), 'comment.create', { projectId: 'p2' });
  });

  it('AC-12 boundary: checkAction answers forbidden for a requester who is not a member of the action\'s project', async () => {
    const { executor, access } = setup(makeTool(), { membership: new ForbiddenAppException({}, 'projects') });

    expect(await executor.checkAction(pendingAction())).toBe('forbidden');
    expect(access.resolveMembership).toHaveBeenCalledWith('p2', expect.objectContaining({ id: 'u1' }));
  });

  it('checkAction answers forbidden for a tool that left the registry', async () => {
    const { executor } = setup(makeTool());

    expect(await executor.checkAction(pendingAction({ tool: 'koda_retired' }))).toBe('forbidden');
  });

  it('checkAction answers forbidden when the action\'s actor cannot be read', async () => {
    const { executor } = setup(makeTool(), { noActor: true });

    expect(await executor.checkAction(pendingAction())).toBe('forbidden');
  });

  it('AC-17: executeAction answers error: <tool> failed when the tool throws a plain Error', async () => {
    const tool = makeTool({ execute: vi.fn(async () => { throw new Error('db down'); }) });
    const { executor } = setup(tool);

    expect(await executor.executeAction(pendingAction())).toEqual({ ok: false, text: 'error: koda_fake failed' });
  });

  it('AC-26: executeAction logs the stack of an ordinary error', async () => {
    const boom = new Error('db down');
    const tool = makeTool({ execute: vi.fn(async () => { throw boom; }) });
    const { executor } = setup(tool);
    const logged = vi.spyOn(Logger.prototype, 'error');
    logged.mockClear();

    await executor.executeAction(pendingAction());

    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain('a1');
    expect(logged.mock.calls[0]?.[1]).toBe(boom.stack);
  });

  it('executeAction answers not_found when the tool raises NotFoundAppException', async () => {
    const tool = makeTool({ execute: vi.fn(async () => { throw new NotFoundAppException({}, 'tickets'); }) });
    const { executor } = setup(tool);

    expect(await executor.executeAction(pendingAction())).toEqual({ ok: false, text: 'not_found' });
  });

  it('AC-21: executeAction runs the tool with the action\'s project slug, not the thread\'s home project', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'comment c1'; } });
    const { executor, access } = setup(tool);

    expect(await executor.executeAction(pendingAction())).toEqual({ ok: true, text: 'comment c1' });
    expect(seen).toMatchObject({
      projectId: 'p2', projectSlug: 'ops', threadId: 't1', jobId: 'j1',
      actor: { id: 'u1', actorType: 'user' },
    });
    expect(access.resolveMembership).toHaveBeenCalledWith('p2', expect.objectContaining({ id: 'u1' }));
  });

  it('AC-10 (US-004): an approved action runs with an actor that carries no projectRole property', async () => {
    let seen: ToolContext | undefined;
    const tool = makeTool({ execute: async (ctx: ToolContext) => { seen = ctx; return 'comment c1'; } });
    const { executor, access } = setup(tool, { role: 'DEVELOPER' });

    expect(await executor.executeAction(pendingAction())).toEqual({ ok: true, text: 'comment c1' });

    // Membership was resolved for the requester, so the actor is still the requester — just not decorated.
    expect(access.resolveMembership).toHaveBeenCalledWith('p2', expect.objectContaining({ id: 'u1' }));
    expect(seen?.actor).toMatchObject({ id: 'u1', actorType: 'user' });
    expect(Object.prototype.hasOwnProperty.call(seen?.actor, 'projectRole')).toBe(false);
  });

  it('executeAction re-parses the stored input and answers the tool text', async () => {
    const parse = vi.fn((input: unknown) => String(input));
    const execute = vi.fn(async () => 'comment c1 added to KODA-1');
    const { executor } = setup(makeTool({ parse, execute }));

    expect(await executor.executeAction(pendingAction({ input: { ref: 'KODA-1', body: 'hello' } })))
      .toEqual({ ok: true, text: 'comment c1 added to KODA-1' });
    expect(parse).toHaveBeenCalledWith({ ref: 'KODA-1', body: 'hello' });
  });

  it('executeAction answers error: <tool> failed when its own parser refuses the stored input', async () => {
    const tool = makeTool({ parse: () => { throw new ToolInputError('ref'); } });
    const { executor } = setup(tool);

    expect(await executor.executeAction(pendingAction())).toEqual({ ok: false, text: 'error: koda_fake failed' });
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describe('S5b 2a-D1: the propose service attaches itself to the executor at init', () => {
  let module: TestingModule;

  beforeEach(async () => {
    const { repo } = makeRepo(context());
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, AssistantModule] })
      .overrideProvider(ASSISTANT_TOOL_CALL_REPOSITORY).useValue(repo)
      .overrideProvider(ProjectAccessService).useValue({ resolveMembership: async () => 'DEVELOPER' })
      .compile();
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('AC-1: after init() a write tool call reaches AssistantActionService.propose and answers pending', async () => {
    const propose = vi.spyOn(module.get(AssistantActionService), 'propose').mockResolvedValue({ actionId: 'a1' });
    const tool = makeWriteTool();
    module.get(AssistantToolRegistry).register(tool);

    const result = await module.get(AssistantToolExecutor).execute(call());

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', tool: 'koda_fake', preview: PREVIEW, actorId: 'u1' }));
    expect(result).toEqual({ content: 'pending a1: awaiting user approval; do not retry', isError: false });
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
