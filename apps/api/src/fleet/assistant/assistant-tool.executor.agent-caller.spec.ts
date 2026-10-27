import { gateDouble } from '../../../test/helpers/assistant-gate-double';
/**
 * Permissions P1 US-001 / P2 US-003 — a thread job runs its tools as its requester, attributed to the assistant.
 *
 * `findCallContext` answers the job's requester, which is an agent when an agent sent the message or called the
 * action. `execute` builds that requester's principal and opens a SYSTEM/assistant context on behalf of it.
 * Both user and agent requesters wait through ApprovalGate by default; explicit none policies keep the direct path.
 *
 * Every case drives the real executor over a stub tool, a stub registry and a stub repository; the DB-backed
 * `findCallContext` reads are in test/integration/fleet/thread-creator-type.integration.spec.ts.
 */
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { currentActor, currentContext, type ActionContext } from '../../action-context/action-context';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from './assistant-tool-call.domain';
import type { AssistantTool, ToolContext } from './assistant-tool.types';

/** An agent `a1` requested the turn of this PROJECT thread; a user made the thread (1d2-D4 kind PROJECT). */
const AGENT_CONTEXT: ToolCallContext = {
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  kind: 'PROJECT',
  creator: { type: 'AGENT', id: 'a1', slug: 'claude', status: 'ACTIVE' },
};

/** The same thread, requested by the user `u1`. */
const USER_CONTEXT: ToolCallContext = {
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  kind: 'PROJECT',
  creator: { type: 'USER', id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false },
};

const CALL = { jobId: 'j1', toolCallId: 'c1' };

function setup(context: ToolCallContext | null, tool: AssistantTool) {
  const rows = [];
  const calls: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async () => null),
    findCallContext: vi.fn(async () => context),
    record: vi.fn(async (row) => { rows.push(row); }),
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const access = { findProjectIdBySlug: async () => 'p1', resolveMembership: async () => 'DEVELOPER' };
  // Permissions P1 US-004: the tool's key is a `PermissionService` read now; every key is allowed here.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const approval = gateDouble();
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions, ...approval.deps);
  return { executor, rows, approval };
}

/**
 * The same wiring, with a repository that really stores its rows: `findByCall` answers a stored `(jobId, toolCallId)`,
 * so a case can tell a replay from a second execution.
 */
function storingSetup(context: ToolCallContext, tool: AssistantTool) {
  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async (jobId, toolCallId) => rows.find((r) => r.jobId === jobId && r.toolCallId === toolCallId) ?? null),
    findCallContext: vi.fn(async () => context),
    record: vi.fn(async (row) => { rows.push(row); }),
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const access = { findProjectIdBySlug: async () => 'p1', resolveMembership: async () => 'DEVELOPER' };
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const approval = gateDouble();
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions, ...approval.deps);
  return { executor, rows, approval };
}

/** A read tool that answers its context to the caller, so a case can read what the executor passed. */
function readTool(onExecute: (ctx: ToolContext) => Promise<string> = async () => 'read text'): AssistantTool<unknown> {
  return {
    descriptor: { name: 'koda_get_ticket', description: 'd', inputSchema: {} },
    key: 'ticket.read',
    parse: (input) => input,
    execute: vi.fn(onExecute),
  };
}

/** The write tool of AC-9 and AC-10: previewed, then proposed or run at once depending on the policy. */
function commentTool(): AssistantTool<unknown> {
  return {
    descriptor: { name: 'koda_add_comment', description: 'd', inputSchema: {} },
    kind: 'write',
    key: 'comment.create',
    parse: (input) => input,
    preview: vi.fn(async () => 'Add comment preview'),
    execute: vi.fn(async () => 'comment c1 added to WEB-1'),
  };
}

/**
 * One thread call through the real executor, answering the action context its tool observed. The tool records
 * `currentContext()` itself, so each assertion reads what the executor really set around the run.
 */
async function contextOfThreadCall(context: ToolCallContext): Promise<ActionContext | undefined> {
  const seen: Array<ActionContext | undefined> = [];
  const tool = readTool(async () => { seen.push(currentContext()); return 'read text'; });
  const { executor } = setup(context, tool);
  await executor.execute({ ...CALL, name: 'koda_get_ticket', input: { ref: 'WEB-1' } });
  return seen[0];
}

describe('AssistantToolExecutor as the assistant for a thread call (US-001, P2 US-003)', () => {
  it("AC-8: an AGENT creator runs the tool with ctx.actor.actorType 'agent' and its id", async () => {
    const tool = readTool();
    const { executor } = setup(AGENT_CONTEXT, tool);
    await executor.execute({ ...CALL, name: 'koda_get_ticket', input: { ref: 'WEB-1' } });
    const [ctx] = vi.mocked(tool.execute).mock.calls[0] as [ToolContext, unknown];
    expect(ctx.actor).toMatchObject({ actorType: 'agent', id: 'a1' });
  });

  it('the agent principal carries its slug, status and capabilities, and is only blacklisted while PAUSED', async () => {
    const tool = readTool();
    const { executor } = setup(AGENT_CONTEXT, tool);
    await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} });
    const [ctx] = vi.mocked(tool.execute).mock.calls[0] as [ToolContext, unknown];
    expect(ctx.actor).toEqual({
      actorType: 'agent', id: 'a1', name: 'claude', slug: 'claude', status: 'ACTIVE',
      capabilities: [], blacklisted: false, revoked: false, authorities: [], extra: { slug: 'claude' },
    });
  });

  it('AC-11: an AGENT creator with id a1 runs the tool with currentActor() SYSTEM/assistant and onBehalfOf a1', async () => {
    const seen: Array<ReturnType<typeof currentActor>> = [];
    const behalf: Array<ActionContext['onBehalfOf']> = [];
    const tool = readTool(async () => {
      seen.push(currentActor());
      behalf.push(currentContext()?.onBehalfOf);
      return 'read text';
    });
    const { executor } = setup(AGENT_CONTEXT, tool);
    await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} });
    expect(seen).toEqual([{ type: 'SYSTEM', id: 'assistant' }]);
    expect(behalf).toEqual([{ type: 'AGENT', id: 'a1' }]);
  });

  it('AC-11: a USER creator runs the tool with currentActor() SYSTEM/assistant and onBehalfOf u1', async () => {
    const seen: Array<ReturnType<typeof currentActor>> = [];
    const behalf: Array<ActionContext['onBehalfOf']> = [];
    const tool = readTool(async () => {
      seen.push(currentActor());
      behalf.push(currentContext()?.onBehalfOf);
      return 'read text';
    });
    const { executor } = setup(USER_CONTEXT, tool);
    await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} });
    expect(seen).toEqual([{ type: 'SYSTEM', id: 'assistant' }]);
    expect(behalf).toEqual([{ type: 'USER', id: 'u1' }]);
  });

  it("AC-1: a USER creator's read call runs the tool with currentContext().actor SYSTEM/assistant", async () => {
    const context = await contextOfThreadCall(USER_CONTEXT);
    expect(context?.actor).toEqual({ type: 'SYSTEM', id: 'assistant' });
  });

  it('AC-2: that call runs on behalf of the USER creator u1', async () => {
    const context = await contextOfThreadCall(USER_CONTEXT);
    expect(context?.onBehalfOf).toEqual({ type: 'USER', id: 'u1' });
  });

  it("AC-3: that call's context has origin 'thread'", async () => {
    const context = await contextOfThreadCall(USER_CONTEXT);
    expect(context?.origin).toBe('thread');
  });

  it("AC-4: an AGENT creator's call runs on behalf of the AGENT a1", async () => {
    const context = await contextOfThreadCall(AGENT_CONTEXT);
    expect(context?.onBehalfOf).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it.each([AGENT_CONTEXT, USER_CONTEXT])('a requester of either type waits through the gate', async (context) => {
    const tool = commentTool();
    const { executor, approval } = setup(context, tool);
    expect(await executor.execute({ ...CALL, name: 'koda_add_comment', input: { ref: 'WEB-1', body: 'x' } }))
      .toEqual({ content: 'pending a1: awaiting approval; do not retry', isError: false });
    expect(approval.gate.gate).toHaveBeenCalledTimes(1);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('AC-13: a call for a job whose requesting agent is gone answers 404 fleet.jobs', async () => {
    const { executor } = setup(null, readTool());
    const error = await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundAppException);
    expect(JSON.stringify(error)).toContain('fleet.jobs');
  });

  /**
   * Thread writes use the approval gate, while the executor's replay key still ensures duplicate calls only store
   * one answer. The tool itself is executed by the gate's registered command, not by this executor.
   */
  it('B1: concurrent calls with one replay key gate once and answer its stored row', async () => {
    const tool = commentTool();
    const { executor, rows, approval } = storingSetup(AGENT_CONTEXT, tool);
    approval.resolver.resolve.mockResolvedValue({ mode: 'none' });
    approval.gate.gate.mockResolvedValue({ status: 'executed', result: { text: 'comment c1 added to WEB-1' } } as never);
    const input = { ref: 'WEB-1', body: 'x' };

    const [first, second] = await Promise.all([
      executor.execute({ ...CALL, name: 'koda_add_comment', input }),
      executor.execute({ ...CALL, name: 'koda_add_comment', input }),
    ]);

    expect(approval.gate.gate).toHaveBeenCalledTimes(1);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(first.content).toContain('comment c1 added to WEB-1');
    expect(second).toEqual(first);
  });

  it('B1: a stored call replayed after the concurrent winner never runs the tool again', async () => {
    const tool = commentTool();
    const { executor, rows, approval } = storingSetup(AGENT_CONTEXT, tool);
    approval.resolver.resolve.mockResolvedValue({ mode: 'none' });
    approval.gate.gate.mockResolvedValue({ status: 'executed', result: { text: 'comment c1 added to WEB-1' } } as never);
    const input = { ref: 'WEB-1', body: 'x' };

    const first = await executor.execute({ ...CALL, name: 'koda_add_comment', input });
    const second = await executor.execute({ ...CALL, name: 'koda_add_comment', input });

    expect(approval.gate.gate).toHaveBeenCalledTimes(1);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(second).toEqual(first);
  });
});
