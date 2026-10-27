/**
 * US-001 (2b1-D1/D2): the three exception mappings the executor adds for write tools.
 *
 * Every test drives the real `AssistantToolExecutor` over a stub tool, with the harness shape of
 * `assistant-tool.executor.spec.ts` (registry + repository stub + injected membership stub + attached proposer), so
 * each assertion reads the agent's answer, the recorded `AssistantToolCall` row and the proposer's calls. No
 * database is involved.
 */
import { Logger } from '@nestjs/common';
import type { PermissionService } from '../../permissions/permission.service';
import { ProjectAccessService } from '../../projects/project-access.service';
import type { PendingActionRecord, ProposeInput, ProposeResult } from './actions/pending-action.domain';
import { AssistantToolExecutor, RESULT_CAP_BYTES } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool } from './assistant-tool.types';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from './assistant-tool-call.domain';

/** The thread this harness runs in: project `web`, creator `u1`, a REPO thread. */
const CALL_CONTEXT: ToolCallContext = {
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false },
};

function makeRepo(): { repo: AssistantToolCallRepository; rows: AssistantToolCallRecord[] } {
  const rows: AssistantToolCallRecord[] = [];
  const repo: AssistantToolCallRepository = {
    // 3-D12: `executeAction` resolves the requester through `findUserActor`, so it answers the same user the
    // call-context stub carries — the creator every approved-action fixture here names.
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => CALL_CONTEXT.creator),
    findByCall: vi.fn(async (jobId: string, toolCallId: string) => rows.find((r) => r.jobId === jobId && r.toolCallId === toolCallId) ?? null),
    record: vi.fn(async (row: AssistantToolCallRecord) => { rows.push(row); }),
    findCallContext: vi.fn(async () => CALL_CONTEXT),
  };
  return { repo, rows };
}

/** The stub write tool of every AC here: name `w`, `kind: 'write'`, so the executor previews and proposes it. */
function makeWriteTool(over: Partial<AssistantTool<unknown>> = {}): AssistantTool<unknown> {
  return {
    descriptor: { name: 'w', description: 'd', inputSchema: {} },
    key: 'comment.create',
    kind: 'write',
    parse: vi.fn((input: unknown) => input),
    preview: vi.fn(async () => 'Add a comment to WEB-1 "Fix"'),
    execute: vi.fn(async () => 'tool text'),
    ...over,
  };
}

function makeProposer(): { propose: ReturnType<typeof vi.fn>; recordDirect: ReturnType<typeof vi.fn> } {
  // 3-D14: the port gained the direct-action record; this harness exercises the propose path.
  return {
    propose: vi.fn(async (_input: ProposeInput): Promise<ProposeResult> => ({ actionId: 'a1' })),
    recordDirect: vi.fn(async (): Promise<{ actionId: string }> => ({ actionId: 'a1' })),
  };
}

interface Setup {
  executor: AssistantToolExecutor;
  tool: AssistantTool<unknown>;
  proposer: { propose: ReturnType<typeof vi.fn> };
  rows: AssistantToolCallRecord[];
}

/** A write tool whose proposer is attached, as `AssistantActionService.onModuleInit` attaches it (2a-D1). */
function setup(over: Partial<AssistantTool<unknown>> = {}): Setup {
  const tool = makeWriteTool(over);
  const { repo, rows } = makeRepo();
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const access = {
    findProjectIdBySlug: vi.fn(async () => CALL_CONTEXT.project.id),
    resolveMembership: vi.fn(async () => 'DEVELOPER'),
  };
  // Permissions P1 US-004: the tool's key is a `PermissionService` read now; every key is allowed here, so the
  // refusal wording these cases pin stays the tool's own (input and preview failures), not a key refusal.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const executor = new AssistantToolExecutor(registry, repo, access as unknown as ProjectAccessService, permissions);
  const proposer = makeProposer();
  executor.attachActions(proposer);
  return { executor, tool, proposer, rows };
}

const call = (over: Partial<{ jobId: string; toolCallId: string; name: string; input: unknown }> = {}) => ({
  jobId: 'j1', toolCallId: 'c1', name: 'w', input: { ref: 'WEB-1' }, ...over,
});

/** One approved action of the `w` stub in project `web`, ready for `executeAction`. */
const approvedAction = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: 'u1', origin: 'thread', approvalMode: 'human', approverType: 'user', approverId: 'u1',
  id: 'a1', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'c1', tool: 'w',
  input: { ref: 'WEB-1' }, preview: 'Add a comment to WEB-1 "Fix"', status: 'APPROVED',
  approvalId: 'ap1', decidedAt: null, result: null, deliveredAt: null,
  expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'), ...over,
});

/** The batch failure US-003..US-007 answer: the lines already applied, then the failure that stopped the batch. */
const PARTIAL_TEXT = 'created KODA-1\nfailed at ticket 2: error';

/** `Logger.prototype.error` is spied on globally by `test-setup.ts`, so every assertion clears it first. */
function errorLog(): ReturnType<typeof vi.spyOn> {
  const logged = vi.spyOn(Logger.prototype, 'error');
  logged.mockClear();
  return logged;
}

describe('US-001 2b1-D1: a write preview refuses with a mapped outcome', () => {
  it("AC-1: a preview raising ToolInputError('status') answers invalid_input: status", async () => {
    const { executor } = setup({ preview: vi.fn(async () => { throw new ToolInputError('status'); }) });

    expect(await executor.execute(call())).toEqual({ content: 'invalid_input: status', isError: true });
  });

  it('#299: a refusal with a detail answers invalid_input: <field>: <detail>', async () => {
    const { executor } = setup({ preview: vi.fn(async () => { throw new ToolInputError('status', 'SB-1 is VERIFY_FIX'); }) });

    expect(await executor.execute(call())).toEqual({ content: 'invalid_input: status: SB-1 is VERIFY_FIX', isError: true });
  });

  it('AC-2: that call never reaches the proposer', async () => {
    const { executor, tool, proposer } = setup({ preview: vi.fn(async () => { throw new ToolInputError('status'); }) });

    // The refusal text is asserted too: without the mapping the call would still stop before `propose`, so the
    // outcome is what tells this path apart from the generic `error: w failed` refusal.
    expect(await executor.execute(call())).toEqual({ content: 'invalid_input: status', isError: true });
    expect(tool.preview).toHaveBeenCalledTimes(1);
    expect(proposer.propose).not.toHaveBeenCalled();
  });

  it('AC-3: the recorded AssistantToolCall row has outcome invalid_input', async () => {
    const { executor, rows } = setup({ preview: vi.fn(async () => { throw new ToolInputError('status'); }) });

    await executor.execute(call());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'invalid_input', isError: true, tool: 'w', projectId: 'p1' });
  });

  it('AC-4: a preview raising ToolForbiddenError(transition Ticket) answers forbidden: w needs transition Ticket on web', async () => {
    const { executor } = setup({ preview: vi.fn(async () => { throw new ToolForbiddenError('transition Ticket'); }) });

    expect(await executor.execute(call())).toEqual({ content: 'forbidden: w needs transition Ticket on web', isError: true });
  });

  it('AC-5: that call never reaches the proposer', async () => {
    const { executor, tool, proposer } = setup({ preview: vi.fn(async () => { throw new ToolForbiddenError('transition Ticket'); }) });

    expect(await executor.execute(call())).toEqual({ content: 'forbidden: w needs transition Ticket on web', isError: true });
    expect(tool.preview).toHaveBeenCalledTimes(1);
    expect(proposer.propose).not.toHaveBeenCalled();
  });

  it('AC-6: the recorded AssistantToolCall row has outcome forbidden', async () => {
    const { executor, rows } = setup({ preview: vi.fn(async () => { throw new ToolForbiddenError('transition Ticket'); }) });

    await executor.execute(call());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'forbidden', isError: true, tool: 'w', projectId: 'p1' });
  });

  it('AC-4 boundary: the refusal names the project the call acts in', async () => {
    const { executor } = setup({ preview: vi.fn(async () => { throw new ToolForbiddenError('update Ticket'); }) });

    expect((await executor.execute(call())).content).toBe('forbidden: w needs update Ticket on web');
  });

  it('AC-1 boundary: a ToolInputError from preview is not logged as an unexpected failure', async () => {
    const logged = errorLog();
    const { executor } = setup({ preview: vi.fn(async () => { throw new ToolInputError('status'); }) });

    await executor.execute(call());

    expect(logged).not.toHaveBeenCalled();
  });

  it('AC-10 regression: a preview raising NotFoundAppException still answers not_found', async () => {
    const { NotFoundAppException } = await import('@nathapp/nestjs-common');
    const { executor, rows } = setup({ preview: vi.fn(async () => { throw new NotFoundAppException({}, 'tickets'); }) });

    expect(await executor.execute(call())).toEqual({ content: 'not_found', isError: true });
    expect(rows[0]).toMatchObject({ outcome: 'not_found', isError: true });
  });

  it('regression: an ordinary preview exception still answers error: w failed and is logged', async () => {
    const logged = errorLog();
    const { executor, rows } = setup({ preview: vi.fn(async () => { throw new Error('db down'); }) });

    expect(await executor.execute(call())).toEqual({ content: 'error: w failed', isError: true });
    expect(logged).toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ outcome: 'error', isError: true });
  });
});

describe('US-001 2b1-D2: an approved action reports a bounded partial outcome', () => {
  it('AC-7: executeAction answers the ToolActionError text as the outcome', async () => {
    const { executor } = setup({ execute: vi.fn(async () => { throw new ToolActionError(PARTIAL_TEXT); }) });

    expect(await executor.executeAction(approvedAction())).toEqual({ ok: false, text: PARTIAL_TEXT });
  });

  it('AC-7: the mapped outcome is not logged as an unexpected failure', async () => {
    const logged = errorLog();
    const { executor } = setup({ execute: vi.fn(async () => { throw new ToolActionError(PARTIAL_TEXT); }) });

    await executor.executeAction(approvedAction());

    expect(logged).not.toHaveBeenCalled();
  });

  it('AC-8: a ToolActionError text larger than the cap is truncated to RESULT_CAP_BYTES', async () => {
    const long = 'x'.repeat(RESULT_CAP_BYTES + 100);
    const { executor } = setup({ execute: vi.fn(async () => { throw new ToolActionError(long); }) });

    const outcome = await executor.executeAction(approvedAction());

    expect(outcome.ok).toBe(false);
    expect(Buffer.byteLength(outcome.text)).toBeLessThanOrEqual(RESULT_CAP_BYTES);
    expect(outcome.text).toContain('[truncated]');
  });

  it('AC-8 boundary: a text that fits the cap is answered whole', async () => {
    const fits = 'y'.repeat(RESULT_CAP_BYTES);
    const { executor } = setup({ execute: vi.fn(async () => { throw new ToolActionError(fits); }) });

    expect(await executor.executeAction(approvedAction())).toEqual({ ok: false, text: fits });
  });

  it('AC-9: a plain Error from execute still answers error: w failed', async () => {
    const { executor } = setup({ execute: vi.fn(async () => { throw new Error('db down'); }) });

    expect(await executor.executeAction(approvedAction())).toEqual({ ok: false, text: 'error: w failed' });
  });

  it('AC-9 boundary: the plain Error is still logged with the action id', async () => {
    const logged = errorLog();
    const boom = new Error('db down');
    const { executor } = setup({ execute: vi.fn(async () => { throw boom; }) });

    await executor.executeAction(approvedAction());

    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain('a1');
    expect(logged.mock.calls[0]?.[1]).toBe(boom.stack);
  });
});
