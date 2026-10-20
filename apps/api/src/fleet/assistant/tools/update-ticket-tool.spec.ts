import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { Priority, TicketStatus } from '../../../common/enums';
import { TicketTransitionsService } from '../../../tickets/state-machine/ticket-transitions.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_UPDATE_TICKET } from '../koda-tool-descriptors';
import { updateTicketTool, type UpdateTicketInput } from './update-ticket-tool';

/**
 * Fleet S5b 2b1 US-004: the ticket update tool's parser, masked field-diff preview and prechecked execution. The
 * tool is pure over its three collaborators here — the DB-backed path (route, propose, approve, the ticket really
 * updated) is `test/integration/fleet/assistant-update-ticket-tool.integration.spec.ts`.
 */

/**
 * Permissions P1 US-004: the start check is the context's `can`, which the executor fills from `PermissionService`.
 * It holds the key until a case says otherwise; `beforeEach` restores it so no case inherits a refusal.
 */
const can = vi.fn(async (_key: string) => true);

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test', projectRole: 'DEVELOPER' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data: (text: string) => text,
  can,
} as unknown as ToolContext;

beforeEach(() => {
  can.mockReset();
  can.mockResolvedValue(true);
});

/** The ticket `TicketsService.findByRef` answers for `KODA-1`, as the preview and `execute` read it. */
const TICKET = {
  ref: 'KODA-1',
  title: 'Fix login',
  description: 'the old text',
  status: TicketStatus.CREATED,
  priority: Priority.MEDIUM,
};

/** The token AC-7-of-US-003 hides: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** The tool over its two collaborators; `ticket` overrides the fields `findByRef` answers. */
function toolDeps(overrides: { ticket?: Record<string, unknown> } = {}) {
  const findByRef = vi.fn(async () => ({ ...TICKET, ...overrides.ticket }));
  const update = vi.fn(async () => ({ ...TICKET, ...overrides.ticket }));
  const assertTransitionPermission = vi.fn(async () => undefined);
  const tickets = { findByRef, update } as unknown as TicketsService;
  const transitions = { assertTransitionPermission } as unknown as TicketTransitionsService;
  return { findByRef, update, assertTransitionPermission, tool: updateTicketTool({ tickets, transitions }) };
}

/** The `reason` a parser refuses with; fails loudly when it accepts or throws something else. */
function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).reason;
  }
  throw new Error('expected the parser to refuse this input');
}

/** The error a call throws; fails loudly when it answers instead. */
async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to refuse');
}

/** The tool's preview; fails loudly when a write tool declares none. */
function previewOf(tool: AssistantTool<UpdateTicketInput>, input: UpdateTicketInput): Promise<string> {
  const preview = tool.preview;
  if (!preview) throw new Error('koda_update_ticket declares no preview');
  return preview(ctx, input);
}

describe('koda_update_ticket parse (US-004)', () => {
  it('AC-1: a ref and no other field refuses with reason changes', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ ref: 'KODA-1' }))).toBe('changes');
  });

  it('AC-2: a status other than IN_PROGRESS refuses with reason status', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ ref: 'KODA-1', status: 'CLOSED' }))).toBe('status');
  });

  it('#299: a status other than IN_PROGRESS says which status is accepted', async () => {
    const failure = await failureOf(async () => toolDeps().tool.parse({ ref: 'KODA-1', status: 'CLOSED' }));

    expect((failure as ToolInputError).detail).toBe('only IN_PROGRESS is accepted');
  });

  it('keeps the fields as written and drops nothing the caller gave', () => {
    const tool = toolDeps().tool;

    expect(tool.parse({ ref: 'KODA-1', title: '  New title  ', priority: 'CRITICAL', status: 'IN_PROGRESS' })).toEqual({
      ref: 'KODA-1',
      title: '  New title  ',
      priority: 'CRITICAL',
      status: 'IN_PROGRESS',
    });
    expect(tool.parse({ ref: 'KODA-1', description: 'line one\nline two' })).toEqual({
      ref: 'KODA-1',
      description: 'line one\nline two',
    });
  });

  it('refuses a ref that is missing, not a string or not a ticket ref', () => {
    const tool = toolDeps().tool;
    expect(reasonOf(() => tool.parse({ title: 'a' }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ref: 7, title: 'a' }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ref: 'koda-1', title: 'a' }))).toBe('ref');
    expect(reasonOf(() => tool.parse(null))).toBe('ref');
  });

  it('refuses a title that is empty after trim, not a string or over 200 characters', () => {
    const tool = toolDeps().tool;
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', title: '   ' }))).toBe('title');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', title: 7 }))).toBe('title');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', title: 'x'.repeat(201) }))).toBe('title');
    expect(tool.parse({ ref: 'KODA-1', title: 'x'.repeat(200) }).title).toBe('x'.repeat(200));
  });

  it('refuses a description over 4000 characters after trim, and a non-string one', () => {
    const tool = toolDeps().tool;
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', description: 'x'.repeat(4_001) }))).toBe('description');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', description: 7 }))).toBe('description');
    // An empty description is a change: it clears the field.
    expect(tool.parse({ ref: 'KODA-1', description: '' }).description).toBe('');
  });

  it('refuses a priority that is not one of the four priorities', () => {
    const tool = toolDeps().tool;
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', priority: 'URGENT' }))).toBe('priority');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', priority: 1 }))).toBe('priority');
    expect(tool.parse({ ref: 'KODA-1', priority: 'LOW' }).priority).toBe('LOW');
  });

  it('is a write tool that carries the ticket.update key', () => {
    const tool = toolDeps().tool;
    expect(tool.descriptor).toBe(KODA_UPDATE_TICKET);
    expect(tool.kind).toBe('write');
    expect(tool.permission).toEqual({ kind: 'ability', action: 'update', subject: 'Ticket' });
    expect(tool.key).toBe('ticket.update');
  });
});

describe('koda_update_ticket preview (US-004)', () => {
  it('AC-3: a priority proposal answers a first line naming the ticket and the project', async () => {
    const { tool } = toolDeps();

    const preview = await tool.preview?.(ctx, tool.parse({ ref: 'KODA-1', priority: 'HIGH' }));

    expect(preview?.split('\n')[0]).toBe('Update KODA-1 "Fix login" in web:');
  });

  it('AC-4: a priority proposal answers the change as its second line', async () => {
    const { tool } = toolDeps();

    const preview = await tool.preview?.(ctx, tool.parse({ ref: 'KODA-1', priority: 'HIGH' }));

    expect(preview?.split('\n')[1]).toBe('priority: MEDIUM -> HIGH');
  });

  it('AC-5: a field-only proposal never checks the transition permission', async () => {
    const { assertTransitionPermission, tool } = toolDeps();

    await tool.preview?.(ctx, tool.parse({ ref: 'KODA-1', title: 'New' }));

    expect(assertTransitionPermission).not.toHaveBeenCalled();
  });

  it('AC-7 (US-004): a start proposal whose context refuses ticket.transition.start refuses with that key', async () => {
    can.mockResolvedValue(false);
    const { tool } = toolDeps();

    const failure = await failureOf(() => previewOf(tool, tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

    expect(failure).toBeInstanceOf(ToolForbiddenError);
    expect((failure as ToolForbiddenError).need).toBe('ticket.transition.start');
    // The key is asked through the context, in the context's project, and never through the legacy transition service.
    expect(can).toHaveBeenCalledWith('ticket.transition.start');
  });

  it('AC-7 boundary: the key is checked before the ticket cannot start', async () => {
    can.mockResolvedValue(false);
    const deps = toolDeps({ ticket: { status: TicketStatus.CLOSED } });

    const failure = await failureOf(() => previewOf(deps.tool, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

    expect(failure).toBeInstanceOf(ToolForbiddenError);
  });

  it('a start proposal whose context holds the key previews the move', async () => {
    const { tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' }));

    expect(preview.split('\n').at(-1)).toBe('status: CREATED -> IN_PROGRESS');
  });

  it('AC-7: a start proposal on a VERIFY_FIX ticket refuses with reason status', async () => {
    const deps = toolDeps({ ticket: { status: TicketStatus.VERIFY_FIX } });

    const failure = await failureOf(() => previewOf(deps.tool, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

    expect(failure).toBeInstanceOf(ToolInputError);
    expect((failure as ToolInputError).reason).toBe('status');
  });

  it('#299: a refused start names the ticket status and the statuses that can start', async () => {
    const deps = toolDeps({ ticket: { status: TicketStatus.VERIFY_FIX } });

    const failure = await failureOf(() => previewOf(deps.tool, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

    expect((failure as ToolInputError).detail).toBe('KODA-1 is VERIFY_FIX; only a CREATED or VERIFIED ticket can be started');
  });

  it('refuses a start from CLOSED, REJECTED and an already started ticket', async () => {
    for (const status of [TicketStatus.CLOSED, TicketStatus.REJECTED, TicketStatus.IN_PROGRESS]) {
      const deps = toolDeps({ ticket: { status } });

      const failure = await failureOf(() => previewOf(deps.tool, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

      expect((failure as ToolInputError).reason).toBe('status');
    }
  });

  it('reads the ticket of the context project, and lets a missing one through as not found', async () => {
    const { findByRef, tool } = toolDeps();
    await tool.preview?.(ctx, tool.parse({ ref: 'KODA-1', title: 'New' }));

    expect(findByRef).toHaveBeenCalledWith('web', 'KODA-1');
  });

  it('lists the changed fields in the order title, description, priority, status', async () => {
    const { tool } = toolDeps();

    const preview = await tool.preview?.(ctx, tool.parse({
      ref: 'KODA-1', title: 'New title', description: 'one\ntwo', priority: 'HIGH', status: 'IN_PROGRESS',
    }));

    expect(preview?.split('\n')).toEqual([
      'Update KODA-1 "Fix login" in web:',
      'title: Fix login -> New title',
      'description:',
      '    one',
      '    two',
      'priority: MEDIUM -> HIGH',
      'status: CREATED -> IN_PROGRESS',
    ]);
  });

  it('never shows the old description, and masks a token in the new one', async () => {
    const { tool } = toolDeps();

    const preview = await tool.preview?.(ctx, tool.parse({ ref: 'KODA-1', description: `token=${TOKEN}` }));

    expect(preview).not.toContain(TOKEN);
    expect(preview).not.toContain('the old text');
    expect(preview).toContain('token=[masked]');
  });
});

describe('koda_update_ticket execute (US-004)', () => {
  it('AC-8: a field change is written once, in the context project, as the caller', async () => {
    const { update, tool } = toolDeps();

    await tool.execute(ctx, tool.parse({ ref: 'KODA-1', priority: 'HIGH' }));

    expect(update.mock.calls).toEqual([['web', 'KODA-1', { priority: 'HIGH' }, ctx.actor]]);
  });

  it('AC-9: answers the updated ticket and its path', async () => {
    const { tool } = toolDeps();

    expect(await tool.execute(ctx, tool.parse({ ref: 'KODA-1', priority: 'HIGH' })))
      .toBe('updated KODA-1 /web/tickets/KODA-1');
  });

  it('AC-10: a start on a ticket that is now CLOSED throws the move it cannot make', async () => {
    const deps = toolDeps({ ticket: { status: TicketStatus.CLOSED } });

    const failure = await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('KODA-1 cannot move from CLOSED to IN_PROGRESS');
  });

  it('AC-11: a start on a ticket that is now CLOSED writes nothing', async () => {
    const deps = toolDeps({ ticket: { status: TicketStatus.CLOSED } });

    await deps.tool.execute(ctx, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })).catch(() => undefined);

    expect(deps.update).not.toHaveBeenCalled();
  });

  it('AC-12 (US-004): a service refusal on the transition names the key the ticket needs', async () => {
    const deps = toolDeps();
    deps.update.mockRejectedValue(new ForbiddenAppException({}, 'tickets'));

    const failure = await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })));

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('forbidden: KODA-1 needs ticket.transition.start');
  });

  it('writes the start and the field changes in one service call', async () => {
    const { update, tool } = toolDeps();

    await tool.execute(ctx, tool.parse({ ref: 'KODA-1', title: 'New', status: 'IN_PROGRESS' }));

    expect(update.mock.calls).toEqual([['web', 'KODA-1', { title: 'New', status: 'IN_PROGRESS' }, ctx.actor]]);
  });

  it('lets a not-found read through, so the executor answers not_found', async () => {
    const deps = toolDeps();
    const notFound = new Error('not found');
    deps.findByRef.mockRejectedValue(notFound);

    expect(await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({ ref: 'KODA-1', status: 'IN_PROGRESS' })))).toBe(notFound);
  });
});
