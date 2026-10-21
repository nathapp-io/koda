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
    permission: { kind: 'ability', action: 'create', subject: 'Comment' },
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
      { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService,
    ),
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
