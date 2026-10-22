/**
 * Permissions P1 US-001 — a thread job runs its tools as its requester.
 *
 * `findCallContext` now answers the job's requester, which is an agent when an agent sent the message or called the
 * action. `execute` builds that requester's principal (`agentPrincipal` for an agent), passes its type to
 * `approvalModeFor`, and runs the tool inside the requester's action context, so an agent's thread write executes at
 * once and everything the tool records carries the agent's type.
 *
 * Every case drives the real executor over a stub tool, a stub registry and a stub repository; the DB-backed
 * `findCallContext` reads are in test/integration/fleet/thread-creator-type.integration.spec.ts.
 */
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { currentActor } from '../../action-context/action-context';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import type { ActionProposer } from './actions/pending-action.domain';
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
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async () => null),
    findCallContext: vi.fn(async () => context),
    record: vi.fn(async (row) => { rows.push(row); }),
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const actions: ActionProposer = {
    propose: vi.fn(async () => ({ actionId: 'pa1' })),
    recordDirect: vi.fn(async () => ({ actionId: 'da1' })),
  };
  const access = { findProjectIdBySlug: async () => 'p1', resolveMembership: async () => 'DEVELOPER' };
  // Permissions P1 US-004: the tool's key is a `PermissionService` read now; every key is allowed here.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions);
  executor.attachActions(actions);
  return { executor, actions, rows };
}

/**
 * The same wiring, with a repository that really stores its rows: `findByCall` answers a stored `(jobId, toolCallId)`,
 * so a case can tell a replay from a second execution.
 */
function storingSetup(context: ToolCallContext, tool: AssistantTool) {
  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async (jobId, toolCallId) => rows.find((r) => r.jobId === jobId && r.toolCallId === toolCallId) ?? null),
    findCallContext: vi.fn(async () => context),
    record: vi.fn(async (row) => { rows.push(row); }),
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const actions: ActionProposer = {
    propose: vi.fn(async () => ({ actionId: 'pa1' })),
    recordDirect: vi.fn(async () => ({ actionId: 'da1' })),
  };
  const access = { findProjectIdBySlug: async () => 'p1', resolveMembership: async () => 'DEVELOPER' };
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions);
  executor.attachActions(actions);
  return { executor, actions, rows };
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

describe('AssistantToolExecutor as the thread requester (US-001)', () => {
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

  it('AC-11: an AGENT creator with id a1 runs the tool with currentActor() { type: AGENT, id: a1 }', async () => {
    const seen: Array<ReturnType<typeof currentActor>> = [];
    const tool = readTool(async () => { seen.push(currentActor()); return 'read text'; });
    const { executor } = setup(AGENT_CONTEXT, tool);
    await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} });
    expect(seen).toEqual([{ type: 'AGENT', id: 'a1' }]);
  });

  it('AC-11: a USER creator runs the tool with currentActor() { type: USER, id: u1 }', async () => {
    const seen: Array<ReturnType<typeof currentActor>> = [];
    const tool = readTool(async () => { seen.push(currentActor()); return 'read text'; });
    const { executor } = setup(USER_CONTEXT, tool);
    await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} });
    expect(seen).toEqual([{ type: 'USER', id: 'u1' }]);
  });

  it("AC-9: an AGENT creator's write runs at once and records a thread-origin agent action", async () => {
    const tool = commentTool();
    const { executor, actions } = setup(AGENT_CONTEXT, tool);
    const result = await executor.execute({ ...CALL, name: 'koda_add_comment', input: { ref: 'WEB-1', body: 'x' } });

    expect(actions.recordDirect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      projectId: 'p1', tool: 'koda_add_comment', actorType: 'agent', actorId: 'a1', origin: 'thread', status: 'EXECUTED',
    }));
    expect(actions.propose).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it("AC-10: a USER creator's write is proposed and never run directly", async () => {
    const tool = commentTool();
    const { executor, actions } = setup(USER_CONTEXT, tool);
    const result = await executor.execute({ ...CALL, name: 'koda_add_comment', input: { ref: 'WEB-1', body: 'x' } });

    expect(actions.propose).toHaveBeenCalledTimes(1);
    expect(actions.recordDirect).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content).toContain('pending pa1');
  });

  it('AC-13: a call for a job whose requesting agent is gone answers 404 fleet.jobs', async () => {
    const { executor } = setup(null, readTool());
    const error = await executor.execute({ ...CALL, name: 'koda_get_ticket', input: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundAppException);
    expect(JSON.stringify(error)).toContain('fleet.jobs');
  });

  /**
   * Branch fix B1: an agent's thread write runs at once, so the only thing standing between a runner's retry and a
   * duplicated comment, ticket batch or dispatch is the replay row — and reading it before executing and inserting it
   * afterwards let two concurrent duplicates of one `(jobId, toolCallId)` both execute. The replay key is a critical
   * section now: the second call awaits the winner's execution and then replays its stored row.
   */
  it('B1: two concurrent calls with one replay key make exactly one agent write and answer its stored row', async () => {
    let writes = 0;
    const tool = commentTool();
    vi.mocked(tool.execute).mockImplementation(async () => {
      writes += 1;
      // Keep the winner in flight long enough for the duplicate to reach its own permission check and preview.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'comment c1 added to WEB-1';
    });
    const { executor, actions, rows } = storingSetup(AGENT_CONTEXT, tool);
    const input = { ref: 'WEB-1', body: 'x' };

    const [first, second] = await Promise.all([
      executor.execute({ ...CALL, name: 'koda_add_comment', input }),
      executor.execute({ ...CALL, name: 'koda_add_comment', input }),
    ]);

    expect(writes).toBe(1);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(actions.recordDirect).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(first.content).toContain('comment c1 added to WEB-1');
    expect(second).toEqual(first);
  });

  it('B1: a stored call replayed after the concurrent winner never runs the tool again', async () => {
    const tool = commentTool();
    const { executor, rows } = storingSetup(AGENT_CONTEXT, tool);
    const input = { ref: 'WEB-1', body: 'x' };

    const first = await executor.execute({ ...CALL, name: 'koda_add_comment', input });
    const second = await executor.execute({ ...CALL, name: 'koda_add_comment', input });

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(second).toEqual(first);
  });
});
