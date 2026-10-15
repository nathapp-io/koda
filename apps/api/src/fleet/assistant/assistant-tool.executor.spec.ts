import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { ToolInputError, type AssistantTool, type ToolContext } from './assistant-tool.types';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from './assistant-tool-call.domain';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import { stableStringify } from '../sync/stable-json';

const GHP = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;

const context = (over: Partial<ToolCallContext['creator']> = {}): ToolCallContext => ({
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false, ...over },
});

function makeRepo(ctx: ToolCallContext | null) {
  const rows: AssistantToolCallRecord[] = [];
  const repo: AssistantToolCallRepository = {
    findByCall: vi.fn(async (jobId, toolCallId) => rows.find((r) => r.jobId === jobId && r.toolCallId === toolCallId) ?? null),
    record: vi.fn(async (row) => { rows.push(row); }),
    findCallContext: vi.fn(async () => ctx),
  };
  return { repo, rows };
}

function makeTool(over: Partial<AssistantTool<string>> = {}): AssistantTool<string> {
  return {
    descriptor: { name: 'koda_fake', description: 'd', inputSchema: {} },
    permission: { kind: 'member' },
    parse: (input) => String(input),
    execute: vi.fn(async () => 'tool text'),
    ...over,
  };
}

interface Setup { executor: AssistantToolExecutor; rows: AssistantToolCallRecord[]; repo: AssistantToolCallRepository; access: { resolveMembership: ReturnType<typeof vi.fn> } }

function setup(tool: AssistantTool<string> | null, opts: { creator?: Partial<ToolCallContext['creator']>; role?: string | null; membership?: Error } = {}): Setup {
  const { repo, rows } = makeRepo(context(opts.creator));
  const access = {
    resolveMembership: vi.fn(async () => {
      if (opts.membership) throw opts.membership;
      return opts.role === undefined ? 'DEVELOPER' : opts.role;
    }),
  };
  const registry = new AssistantToolRegistry();
  if (tool) registry.register(tool as AssistantTool);
  const executor = new AssistantToolExecutor(registry, repo, access as unknown as ProjectAccessService, new KodaCaslAbilityFactory());
  return { executor, rows, repo, access };
}

const call = (over: Partial<{ jobId: string; toolCallId: string; name: string; input: unknown }> = {}) => ({
  jobId: 'j1', toolCallId: 'c1', name: 'koda_fake', input: { ref: 'WEB-1' }, ...over,
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

  it('AC-6: an ability tool declaring create FleetJob refuses a project VIEWER', async () => {
    const tool = makeTool({ permission: { kind: 'ability', action: 'create', subject: 'FleetJob' } });
    const { executor } = setup(tool, { role: 'VIEWER' });
    expect(await executor.execute(call())).toEqual({ content: 'forbidden: koda_fake needs create FleetJob on web', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('AC-6: the same ability tool runs for a project DEVELOPER', async () => {
    const tool = makeTool({ permission: { kind: 'ability', action: 'create', subject: 'FleetJob' } });
    const { executor } = setup(tool, { role: 'DEVELOPER' });
    expect((await executor.execute(call())).isError).toBe(false);
  });

  it('AC-7: a global ADMIN creator with no ProjectMember row runs a member tool', async () => {
    const { executor, access } = setup(makeTool(), { creator: { role: 'ADMIN' }, role: 'ADMIN' });
    expect((await executor.execute(call())).isError).toBe(false);
    expect(access.resolveMembership).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'u1', role: 'ADMIN' }));
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
    expect(seen).toMatchObject({ projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', actor: { id: 'u1', actorType: 'user', projectRole: 'DEVELOPER' } });
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
    const winner: AssistantToolCallRecord = { jobId: 'j1', threadId: 't1', projectId: 'p1', toolCallId: 'c1', tool: 'koda_fake', inputHash: createHash('sha256').update(stableStringify(call().input)).digest('hex'), outcome: 'ok', content: 'winner', isError: false, resultBytes: 6, durationMs: 1 };
    let lookups = 0;
    repo.findByCall = vi.fn(async () => (lookups++ === 0 ? null : winner));
    repo.record = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: 'AssistantToolCall_jobId_toolCallId_key' } });
    });
    const registry = new AssistantToolRegistry();
    registry.register(tool as AssistantTool);
    const executor = new AssistantToolExecutor(registry, repo, { resolveMembership: async () => 'DEVELOPER' } as unknown as ProjectAccessService, new KodaCaslAbilityFactory());
    expect(await executor.execute(call())).toEqual({ content: 'winner', isError: false });
    expect(rows).toHaveLength(0);
  });
});
