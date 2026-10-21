/**
 * Branch review B2: whatever an approved tool answers becomes the action's stored `result`, the text of the thread's
 * outcome note and — through that note — part of the next turn's delivery to the agent. A tool that merely echoes
 * something the user approved can echo a credential with it (`koda_link_tickets` repeats the URL it linked), so the
 * executor masks both shapes of answer before anything is persisted.
 *
 * The chain is driven end to end here without a database: the real `AssistantToolExecutor` over a stub tool, then the
 * real `outcomeNote` and `deliveryText` over the answer it produced — the same three steps `AssistantActionDecisions`
 * takes after an approve.
 */
import type { PermissionService } from '../../../permissions/permission.service';
import { ProjectAccessService } from '../../../projects/project-access.service';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolActionError, type AssistantTool } from '../assistant-tool.types';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from '../assistant-tool-call.domain';
import { deliveryText } from './outcome-delivery';
import { outcomeNote } from './outcome-note';
import type { PendingActionRecord, ProposeInput, ProposeResult } from './pending-action.domain';

/** The thread this harness runs in: project `web`, creator `u1`, a REPO thread. */
const CALL_CONTEXT: ToolCallContext = {
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false },
};

/** The token a link URL carries into the tool's answer: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
/** What the tool answers: the line `koda_link_tickets` writes, credential and all. */
const LINK_LINE = `linked KODA-1 https://x.dev/a?token=${TOKEN}`;
/** The same line once masked; the token's own value is gone and only `[masked]` is left in its place. */
const MASKED_LINK_LINE = 'linked KODA-1 https://x.dev/a?token=[masked]';
/** `THREAD_LIMITS.messageMaxBytes` is 32,768: the budget one hand-off has for notes and the user's text. */
const DELIVERY_MAX_BYTES = 32_768;

/** The stub write tool: name `koda_link_tickets`, so the assertions read like the tool that found this. */
function makeLinkTool(execute: () => Promise<string>): AssistantTool<unknown> {
  return {
    descriptor: { name: 'koda_link_tickets', description: 'd', inputSchema: {} },
    permission: { kind: 'member' },
    key: 'ticket.link.add',
    kind: 'write',
    parse: (input: unknown) => input,
    preview: async () => 'Link 1 URL(s) in web:',
    execute,
  };
}

/** The executor over that tool, with the call context and membership it needs; no database is involved. */
function executorFor(tool: AssistantTool<unknown>): AssistantToolExecutor {
  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    // 3-D12: `executeAction` resolves the requester through `findUserActor`, so it answers the same user the
    // call-context stub carries — the creator `approvedAction()` names.
    findUserActor: vi.fn(async () => CALL_CONTEXT.creator),
    findByCall: async () => null,
    record: async (row) => { rows.push(row); },
    findCallContext: async () => CALL_CONTEXT,
  };
  const access = {
    findProjectIdBySlug: async () => CALL_CONTEXT.project.id,
    resolveMembership: async () => 'DEVELOPER',
  };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  // Permissions P1 US-004: the tool's key is a `PermissionService` read now; every key is allowed here.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions);
  // 3-D14: the port carries `recordDirect` too; this harness only drives the thread propose path.
  executor.attachActions({
    propose: async (_input: ProposeInput): Promise<ProposeResult> => ({ actionId: 'a1' }),
    recordDirect: async (): Promise<{ actionId: string }> => ({ actionId: 'a1' }),
  });
  return executor;
}

/** One approved action of that tool in project `web`, ready for `executeAction`. */
const approvedAction = (): PendingActionRecord => ({
  actorType: 'user', actorId: 'u1', origin: 'thread', approvalMode: 'human', approverType: 'user', approverId: 'u1',
  id: 'a1', projectId: 'p1', projectSlug: 'web', threadId: 't1', jobId: 'j1', toolCallId: 'c1',
  tool: 'koda_link_tickets', input: { links: [{ ref: 'KODA-1', url: 'https://x.dev/a' }] },
  preview: 'Link 1 URL(s) in web:', status: 'APPROVED', approvalId: 'ap1',
  decidedAt: null, result: null, deliveredAt: null,
  expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'),
});

describe('B2: an approved tool answer is masked before it is stored', () => {
  it('masks a credential in the result of a tool that succeeded', async () => {
    const executor = executorFor(makeLinkTool(async () => LINK_LINE));

    const outcome = await executor.executeAction(approvedAction());

    expect(outcome).toEqual({ ok: true, text: MASKED_LINK_LINE });
    expect(outcome.text).not.toContain(TOKEN);
  });

  it('masks a credential in the partial outcome of a tool that failed partway', async () => {
    const executor = executorFor(makeLinkTool(async () => { throw new ToolActionError(`${LINK_LINE}\nfailed at link 2: not_found`); }));

    const outcome = await executor.executeAction(approvedAction());

    expect(outcome).toEqual({ ok: false, text: `${MASKED_LINK_LINE}\nfailed at link 2: not_found` });
    expect(outcome.text).not.toContain(TOKEN);
  });
});

describe('B2: the stored result reaches the thread note and the next delivery already masked', () => {
  it('leaves no credential in the outcome note, nor in the text the agent reads on its next turn', async () => {
    const executor = executorFor(makeLinkTool(async () => LINK_LINE));
    const outcome = await executor.executeAction(approvedAction());
    // What `AssistantActionDecisions.finalize` writes: the outcome text is the action's `result`, the note quotes it.
    const note = outcomeNote({ id: 'a1', tool: 'koda_link_tickets', status: 'EXECUTED', result: outcome.text });
    // What the runner receives on the next turn: the note, then the user's message.
    const delivery = deliveryText([note], 'and the next one?', DELIVERY_MAX_BYTES);

    expect(note).toContain(MASKED_LINK_LINE);
    expect(note).not.toContain(TOKEN);
    expect(delivery.delivered).toBe(1);
    expect(delivery.text).toContain(MASKED_LINK_LINE);
    expect(delivery.text).not.toContain(TOKEN);
  });
});
