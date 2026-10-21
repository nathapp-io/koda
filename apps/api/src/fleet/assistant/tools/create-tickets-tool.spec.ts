import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketsService } from '../../../tickets/tickets.service';
import { ToolActionError, ToolInputError, type ToolContext } from '../assistant-tool.types';
import { KODA_CREATE_TICKETS } from '../koda-tool-descriptors';
import { createTicketsTool } from './create-tickets-tool';

/**
 * Fleet S5b 2b1 US-003: the batch create tool's parser, masked preview and serial execution. The tool is pure over
 * its one dependency here — the DB-backed path (route, propose, approve, the tickets really created) is
 * `test/integration/fleet/assistant-create-tickets-tool.integration.spec.ts`.
 */

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test', projectRole: 'DEVELOPER' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data: (text: string) => text,
} as unknown as ToolContext;

/** The token AC-7 hides: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** A `TicketsService.create` stand-in answering the given refs in call order; an `Error` entry is thrown. */
function ticketDeps(answers: (string | Error)[] = ['KODA-5', 'KODA-6']) {
  let call = 0;
  const create = vi.fn(async () => {
    const answer = answers[call++] ?? `KODA-${call}`;
    if (answer instanceof Error) throw answer;
    return { ref: answer };
  });
  return { create, tool: createTicketsTool({ tickets: { create } as unknown as TicketsService }) };
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

/** 21 minimal valid tickets, one more than the bound. */
const tooMany = Array.from({ length: 21 }, (_, i) => ({ type: 'TASK', title: `t${i}` }));

describe('koda_create_tickets parse (US-003)', () => {
  it('AC-1: an empty tickets array refuses with reason tickets', () => {
    expect(reasonOf(() => ticketDeps().tool.parse({ tickets: [] }))).toBe('tickets');
  });

  it('AC-2: 21 tickets refuse with reason tickets', () => {
    expect(reasonOf(() => ticketDeps().tool.parse({ tickets: tooMany }))).toBe('tickets');
  });

  it('AC-3: an unknown type on the second ticket refuses with reason tickets[1].type', () => {
    expect(
      reasonOf(() =>
        ticketDeps().tool.parse({ tickets: [{ type: 'TASK', title: 'a' }, { type: 'EPIC', title: 'b' }] }),
      ),
    ).toBe('tickets[1].type');
  });

  it('AC-4: a whitespace-only title refuses with reason tickets[0].title', () => {
    expect(reasonOf(() => ticketDeps().tool.parse({ tickets: [{ type: 'TASK', title: '   ' }] }))).toBe('tickets[0].title');
  });

  it('accepts 1 and 20 tickets, keeping type, title, description and priority as written', () => {
    const tool = ticketDeps().tool;

    expect(tool.parse({ tickets: [{ type: 'BUG', title: '  Add login  ' }] })).toEqual({
      tickets: [{ type: 'BUG', title: '  Add login  ' }],
    });
    expect(tool.parse({
      tickets: Array.from({ length: 20 }, (_, i) => ({ type: 'TASK', title: `t${i}`, description: 'd', priority: 'LOW' })),
    }).tickets).toHaveLength(20);
  });

  it('refuses a tickets value that is absent, not an array or items that are not objects', () => {
    const tool = ticketDeps().tool;
    expect(reasonOf(() => tool.parse({}))).toBe('tickets');
    expect(reasonOf(() => tool.parse(null))).toBe('tickets');
    expect(reasonOf(() => tool.parse({ tickets: 'x' }))).toBe('tickets');
    expect(reasonOf(() => tool.parse({ tickets: [null] }))).toBe('tickets[0].type');
    expect(reasonOf(() => tool.parse({ tickets: [['TASK', 'a']] }))).toBe('tickets[0].type');
  });

  it('refuses a missing, non-string or over-long title, and a 201-character one after trim', () => {
    const tool = ticketDeps().tool;
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK' }] }))).toBe('tickets[0].title');
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK', title: 7 }] }))).toBe('tickets[0].title');
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK', title: 'x'.repeat(201) }] }))).toBe('tickets[0].title');
    expect(tool.parse({ tickets: [{ type: 'TASK', title: 'x'.repeat(200) }] }).tickets[0]?.title).toBe('x'.repeat(200));
  });

  it('refuses a non-string or over-long description, judged after trim', () => {
    const tool = ticketDeps().tool;
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK', title: 'a', description: 7 }] })))
      .toBe('tickets[0].description');
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK', title: 'a', description: 'x'.repeat(4_001) }] })))
      .toBe('tickets[0].description');
    expect(tool.parse({ tickets: [{ type: 'TASK', title: 'a', description: '  x  ' }] }).tickets[0]?.description).toBe('  x  ');
  });

  it('refuses a priority that is not one of the four priorities', () => {
    const tool = ticketDeps().tool;
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK', title: 'a', priority: 'URGENT' }] })))
      .toBe('tickets[0].priority');
    expect(reasonOf(() => tool.parse({ tickets: [{ type: 'TASK', title: 'a', priority: 1 }] })))
      .toBe('tickets[0].priority');
    expect(tool.parse({ tickets: [{ type: 'TASK', title: 'a', priority: 'CRITICAL' }] }).tickets[0]?.priority).toBe('CRITICAL');
  });

  it('is a write tool that needs create Ticket', () => {
    const tool = ticketDeps().tool;
    expect(tool.descriptor).toBe(KODA_CREATE_TICKETS);
    expect(tool.kind).toBe('write');
    expect(tool.key).toBe('ticket.create');
  });
});

describe('koda_create_tickets preview (US-003)', () => {
  it('AC-5: two tickets in web answer a first line naming the project and the count', async () => {
    const { tool } = ticketDeps();

    const preview = await tool.preview?.(ctx, tool.parse({ tickets: [{ type: 'TASK', title: 'a' }, { type: 'BUG', title: 'b' }] }));

    expect(preview?.split('\n')[0]).toBe('Create 2 ticket(s) in web:');
  });

  it('AC-6: a ticket with no priority reads the default MEDIUM', async () => {
    const { tool } = ticketDeps();

    const preview = await tool.preview?.(ctx, tool.parse({ tickets: [{ type: 'TASK', title: 'Add login' }] }));

    expect(preview?.split('\n')[1]).toBe('1. [TASK, MEDIUM] Add login');
  });

  it('AC-7: a description holding a token is masked, and the token never appears', async () => {
    const { tool } = ticketDeps();

    const preview = await tool.preview?.(ctx, tool.parse({
      tickets: [{ type: 'TASK', title: 'Rotate the key', description: `token=${TOKEN}` }],
    }));

    expect(preview).not.toContain(TOKEN);
    expect(preview).toContain('token=[masked]');
  });

  it('numbers each ticket and indents every description line by four spaces', async () => {
    const { tool } = ticketDeps();

    const preview = await tool.preview?.(ctx, tool.parse({
      tickets: [
        { type: 'BUG', title: 'a', description: 'one\ntwo' },
        { type: 'ENHANCEMENT', title: 'b', priority: 'HIGH' },
      ],
    }));

    expect(preview?.split('\n')).toEqual([
      'Create 2 ticket(s) in web:',
      '1. [BUG, MEDIUM] a',
      '    one',
      '    two',
      '2. [ENHANCEMENT, HIGH] b',
    ]);
  });
});

describe('koda_create_tickets execute (US-003)', () => {
  it('AC-8: each ticket is created in order, in the context\'s project, as the caller', async () => {
    const { create, tool } = ticketDeps();

    await tool.execute(ctx, tool.parse({
      tickets: [
        { type: 'TASK', title: 'a', description: 'first', priority: 'HIGH' },
        { type: 'QUESTION', title: 'b', description: 'second', priority: 'LOW' },
      ],
    }));

    expect(create.mock.calls).toEqual([
      ['web', { type: 'TASK', title: 'a', description: 'first', priority: 'HIGH' }, ctx.actor],
      ['web', { type: 'QUESTION', title: 'b', description: 'second', priority: 'LOW' }, ctx.actor],
    ]);
  });

  it('AC-9: answers one line per ticket, naming its ref and path', async () => {
    const { tool } = ticketDeps(['KODA-5', 'KODA-6']);

    const content = await tool.execute(ctx, tool.parse({ tickets: [{ type: 'TASK', title: 'a' }, { type: 'TASK', title: 'b' }] }));

    expect(content).toBe('created KODA-5 /web/tickets/KODA-5\ncreated KODA-6 /web/tickets/KODA-6');
  });

  it('AC-10: a plain failure on the second ticket throws a ToolActionError quoting what was already created', async () => {
    const tool = ticketDeps(['KODA-5', new Error('ticket store is down')]).tool;

    const failure = await tool.execute(ctx, tool.parse({
      tickets: [{ type: 'TASK', title: 'a' }, { type: 'TASK', title: 'b' }, { type: 'TASK', title: 'c' }],
    })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('created KODA-5 /web/tickets/KODA-5\nfailed at ticket 2: error');
  });

  it('a not-found failure names not_found and stops at that ticket', async () => {
    const { create, tool } = ticketDeps([new NotFoundAppException({}, 'tickets')]);

    const failure = await tool.execute(ctx, tool.parse({ tickets: [{ type: 'TASK', title: 'a' }, { type: 'TASK', title: 'b' }] }))
      .catch((error: unknown) => error);

    expect((failure as ToolActionError).text).toBe('failed at ticket 1: not_found');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
