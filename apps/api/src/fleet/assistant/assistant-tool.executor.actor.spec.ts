import { gateDouble } from '../../../test/helpers/assistant-gate-double';
/**
 * Fleet S5b 3-D12 / 3-R3: the approval check and the approved run read the requester from the action's actor.
 *
 * A `PendingAction` no longer always belongs to a thread job (a direct or MCP action carries none), so
 * `checkAction`/`executeAction` resolve the requester through `findUserActor(action.actorId)` instead of the job's
 * thread creator. The actor is who asked for the write — an approver is never the actor, and an action whose actor is
 * not a `user` is refused without a read (no code default produces one; koda #301).
 *
 * Every test drives the real executor over a stub tool and a stub repository, so each assertion reads the calls the
 * executor made and the context the tool received. The DB-backed reads are in
 * test/integration/fleet/assistant-action-actor.integration.spec.ts and the end-to-end approve is in
 * test/integration/fleet/assistant-actor-approve.integration.spec.ts.
 */
import { currentContext, type ActionContext } from '../../action-context/action-context';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import type { PendingActionRecord } from './actions/pending-action.domain';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantTool, ToolContext } from './assistant-tool.types';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from './assistant-tool-call.domain';

/** The thread's own creator (`u1`, a REPO thread of `web`): the actor today's `findCallContext` read answered. */
const THREAD = { project: { id: 'p1', slug: 'web' }, threadId: 't1', creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false } };
/** An action's actor. `u2` is deliberately not the thread's creator, so an actor read is told apart from a context read. */
const REQUESTER = { id: 'u2', email: 'u2@koda.test', role: 'MEMBER', disabled: false };

type UserRow = ToolCallContext['creator'];

interface Setup {
  executor: AssistantToolExecutor;
  tool: AssistantTool<Record<string, unknown>>;
  readUser: ReturnType<typeof vi.fn>;
  readContext: ReturnType<typeof vi.fn>;
  resolveMembership: ReturnType<typeof vi.fn>;
}

/** The executor over a stub tool, with `findUserActor` answering `users` and `findCallContext` answering `THREAD`. */
function setup(users: Record<string, UserRow> = {}, opts: { membership?: Error } = {}): Setup {
  const readUser = vi.fn(async (userId: string) => users[userId] ?? null);
  const readContext = vi.fn(async () => THREAD);
  const calls: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: readUser,
    findByCall: vi.fn(async () => null),
    record: vi.fn(async (_row: AssistantToolCallRecord) => undefined),
    findCallContext: readContext,
  };
  const resolveMembership = vi.fn(async () => {
    if (opts.membership) throw opts.membership;
    return 'DEVELOPER';
  });
  const access = { findProjectIdBySlug: vi.fn(async () => 'p1'), resolveMembership };
  const tool: AssistantTool<Record<string, unknown>> = {
    descriptor: { name: 'koda_add_comment', description: 'd', inputSchema: {} },
    key: 'comment.create',
    parse: vi.fn((input) => input as Record<string, unknown>),
    execute: vi.fn(async () => 'comment c1 added to OPS-1'),
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  return {
    // Permissions P1 US-004: the key check is a `PermissionService` read now; this double allows every key, so the
    // assertions here stay about the actor the approval resolves.
    executor: new AssistantToolExecutor(
      registry, calls, access as unknown as ProjectAccessService,
      { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService, ...gateDouble().deps),
    tool,
    readUser,
    readContext,
    resolveMembership,
  };
}

/** One stored action of `koda_add_comment` in project `ops`, requested by `u2` and approved by the ADMIN `u9`. */
const action = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: REQUESTER.id, origin: 'thread', approvalMode: 'human', approverType: 'user', approverId: 'u9',
  id: 'a1', projectId: 'p2', projectSlug: 'ops', threadId: 't1', jobId: 'j1', toolCallId: 'c1', tool: 'koda_add_comment',
  input: { ref: 'OPS-1', body: 'hello' }, preview: 'Add a comment to OPS-1 "Fix":\n\nhello', status: 'PENDING',
  approvalId: 'ap1', decidedAt: null, result: null, deliveredAt: null,
  expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'), ...over,
});

describe('S5b 3-D12: checkAction resolves the requester from the action\'s actor', () => {
  it('AC-1: calls findUserActor with the action\'s actorId and never reads the call context', async () => {
    const { executor, readUser, readContext } = setup({ [REQUESTER.id]: REQUESTER });

    expect(await executor.checkAction(action())).toBe('ok');

    expect(readUser).toHaveBeenCalledWith(REQUESTER.id);
    expect(readUser).toHaveBeenCalledTimes(1);
    expect(readContext).not.toHaveBeenCalled();
  });

  it('AC-1 boundary: the actor read is the action\'s, not the job\'s thread creator', async () => {
    // Only `u1` — the thread's creator — is known, so an action requested by `u2` has no actor.
    const { executor, readUser } = setup({ [THREAD.creator.id]: THREAD.creator });

    expect(await executor.checkAction(action({ actorId: 'u2' }))).toBe('forbidden');
    expect(readUser).toHaveBeenCalledWith('u2');
    expect(readUser).not.toHaveBeenCalledWith('u1');
  });

  it('AC-2: a disabled actor answers forbidden', async () => {
    const { executor } = setup({ [REQUESTER.id]: { ...REQUESTER, disabled: true } });

    expect(await executor.checkAction(action())).toBe('forbidden');
  });

  it('AC-2 boundary: an actor who no longer exists answers forbidden', async () => {
    const { executor } = setup();

    expect(await executor.checkAction(action())).toBe('forbidden');
  });

  it('AC-3: an agent actor answers forbidden without reading any user', async () => {
    const { executor, readUser, readContext } = setup({ [REQUESTER.id]: REQUESTER });

    expect(await executor.checkAction(action({ actorType: 'agent', actorId: 'claude-id' }))).toBe('forbidden');
    expect(readUser).not.toHaveBeenCalled();
    expect(readContext).not.toHaveBeenCalled();
  });

  it('3-R3: the approver is not the actor, so an action with a foreign approver still checks its requester', async () => {
    const { executor, readUser } = setup({ [REQUESTER.id]: REQUESTER });

    expect(await executor.checkAction(action({ approverType: 'user', approverId: 'u9' }))).toBe('ok');

    expect(readUser).toHaveBeenCalledTimes(1);
    expect(readUser).not.toHaveBeenCalledWith('u9');
  });
});

describe('S5b 3-D12: executeAction runs the tool as the action\'s actor', () => {
  it('AC-4: the tool\'s execute receives ctx.actor.id equal to the action\'s actorId', async () => {
    const { executor, tool } = setup({ [REQUESTER.id]: REQUESTER });

    expect(await executor.executeAction(action())).toEqual({ ok: true, text: 'comment c1 added to OPS-1' });

    expect(tool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ id: REQUESTER.id, actorType: 'user' }) }),
      { ref: 'OPS-1', body: 'hello' },
    );
  });

  it('AC-10 (US-004): the approved actor carries no projectRole property', async () => {
    const { executor, tool } = setup({ [REQUESTER.id]: REQUESTER });

    await executor.executeAction(action());

    const actor = vi.mocked(tool.execute).mock.calls[0]?.[0].actor;
    expect(actor).toMatchObject({ id: REQUESTER.id, actorType: 'user' });
    expect(Object.prototype.hasOwnProperty.call(actor, 'projectRole')).toBe(false);
  });

  it('AC-4: the context the tool receives names the action\'s own project, thread and job', async () => {
    let seen: ToolContext | undefined;
    const { executor, tool } = setup({ [REQUESTER.id]: REQUESTER });
    vi.mocked(tool.execute).mockImplementation(async (ctx: ToolContext) => { seen = ctx; return 'ok'; });

    await executor.executeAction(action());

    expect(seen).toMatchObject({ projectId: 'p2', projectSlug: 'ops', threadId: 't1', jobId: 'j1' });
  });

  it('AC-4 boundary: another user\'s action runs as that user', async () => {
    const { executor, tool } = setup({ [THREAD.creator.id]: THREAD.creator });

    await executor.executeAction(action({ actorId: THREAD.creator.id }));

    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ id: 'u1' }) }), expect.anything());
  });

  it('3-R3: an executed action runs as its requester, never as its approver', async () => {
    const { executor, tool, readUser } = setup({ [REQUESTER.id]: REQUESTER, u9: { id: 'u9', email: 'u9@koda.test', role: 'ADMIN', disabled: false } });

    await executor.executeAction(action({ approverType: 'user', approverId: 'u9' }));

    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ id: REQUESTER.id }) }), expect.anything());
    expect(readUser).toHaveBeenCalledTimes(1);
    expect(readUser).not.toHaveBeenCalledWith('u9');
  });

  it('a disabled actor runs nothing and answers the generic failure', async () => {
    const { executor, tool } = setup({ [REQUESTER.id]: { ...REQUESTER, disabled: true } });

    expect(await executor.executeAction(action())).toEqual({ ok: false, text: 'error: koda_add_comment failed' });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('an agent actor runs nothing and answers the generic failure', async () => {
    const { executor, tool } = setup({ [REQUESTER.id]: REQUESTER });

    expect(await executor.executeAction(action({ actorType: 'agent', actorId: 'claude-id' }))).toEqual({ ok: false, text: 'error: koda_add_comment failed' });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('an actor who is no longer a member of the action\'s project runs nothing', async () => {
    const { ForbiddenAppException } = await import('@nathapp/nestjs-common');
    const { executor, tool } = setup({ [REQUESTER.id]: REQUESTER }, { membership: new ForbiddenAppException({}, 'projects') });

    expect(await executor.executeAction(action())).toEqual({ ok: false, text: 'error: koda_add_comment failed' });
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
/**
 * Permissions P2 US-003: an approved action is the assistant acting for the requester that asked for the write, so
 * the run is attributed to `SYSTEM/assistant` with the requester as `onBehalfOf` and the action's approval block.
 * The authorization principal and `ctx.actor` stay the requester's (asserted above); a SYSTEM action context changes
 * attribution, not authority.
 */
const U1 = { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false };

/** `pa1`, requested by the user `u1` and approved by the user `u2` — the approver is deliberately not the actor. */
const APPROVED = action({ id: 'pa1', actorId: U1.id, approvalMode: 'human', approverType: 'user', approverId: 'u2' });

/** Runs one approved action through the real executor, answering the context its tool observed. */
async function contextOfAction(record: PendingActionRecord, users: Record<string, UserRow> = { [U1.id]: U1 }): Promise<ActionContext | undefined> {
  const seen: Array<ActionContext | undefined> = [];
  const { executor, tool } = setup(users);
  vi.mocked(tool.execute).mockImplementation(async () => { seen.push(currentContext()); return 'comment c1 added to OPS-1'; });
  await executor.executeAction(record);
  return seen[0];
}

describe('Permissions P2 US-003: an approved action runs as the assistant for its requester', () => {
  it('AC-5: the tool observes currentContext().actor SYSTEM/assistant', async () => {
    const context = await contextOfAction(APPROVED);

    expect(context?.actor).toEqual({ type: 'SYSTEM', id: 'assistant' });
  });

  it('AC-6: the tool observes onBehalfOf the action\'s requester u1', async () => {
    const context = await contextOfAction(APPROVED);

    expect(context?.onBehalfOf).toEqual({ type: 'USER', id: 'u1' });
  });

  it("AC-7: a human approval by the user u2 carries requiredMode human, satisfiedBy human and approverType USER", async () => {
    const context = await contextOfAction(APPROVED);

    expect(context?.approval).toEqual({
      requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1',
    });
  });

  it("AC-7: the action's own context has origin 'thread'", async () => {
    const context = await contextOfAction(APPROVED);

    expect(context?.origin).toBe('thread');
  });

  it("AC-8: an agent approver a9 is satisfiedBy agent with approverType AGENT", async () => {
    const context = await contextOfAction(action({
      id: 'pa8', actorId: U1.id, approvalMode: 'agent', approverType: 'agent', approverId: 'a9',
    }));

    expect(context?.approval).toMatchObject({ satisfiedBy: 'agent', approverType: 'AGENT', approverId: 'a9' });
  });

  it('AC-9: an unapproved action carries requiredMode none, satisfiedBy none and no approver fields', async () => {
    const context = await contextOfAction(action({
      id: 'pa9', actorId: U1.id, approvalMode: 'none', approverType: null, approverId: null,
    }));

    expect(context?.approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none', requestId: 'pa9' });
  });

  it('AC-9 boundary: a null approverType drops a populated approverId, naming no approver at all', async () => {
    // The two columns are independently nullable, so a row may carry an id with no type; an id alone names nobody.
    const context = await contextOfAction(action({
      id: 'pa9b', actorId: U1.id, approvalMode: 'none', approverType: null, approverId: 'u3',
    }));

    expect(context?.approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none', requestId: 'pa9b' });
  });

  it('AC-13: a disabled requester still runs nothing at all', async () => {
    const seen: Array<ActionContext | undefined> = [];
    const { executor, tool } = setup({ [U1.id]: { ...U1, disabled: true } });
    vi.mocked(tool.execute).mockImplementation(async () => { seen.push(currentContext()); return 'ran'; });

    expect(await executor.executeAction(APPROVED)).toEqual({ ok: false, text: 'error: koda_add_comment failed' });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
