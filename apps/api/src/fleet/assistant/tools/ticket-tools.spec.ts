import { Test, type TestingModule } from '@nestjs/testing';
import { CommentsService } from '../../../comments/comments.service';
import { TicketLinksService } from '../../../ticket-links/ticket-links.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolInputError, type ToolContext } from '../assistant-tool.types';
import { KODA_TOOL_DESCRIPTORS } from '../koda-tool-descriptors';
import { TicketTools, getTicketTool, searchTicketsTool } from './ticket-tools';

const TOOL_NAMES = ['koda_search_tickets', 'koda_get_ticket'] as const;

/** The parsers never touch a service, so the stubs only satisfy the DI graph. */
const stubTickets = {} as TicketsService;
const stubLinks = {} as TicketLinksService;
const stubComments = {} as CommentsService;

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

// The real registry, filled by TicketTools.onModuleInit through Nest's lifecycle.
describe('ticket read tools (US-003)', () => {
  let module: TestingModule;
  let registry: AssistantToolRegistry;
  const search = () => searchTicketsTool(stubTickets);
  const get = () => getTicketTool({ tickets: stubTickets, links: stubLinks, comments: stubComments });

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        TicketTools,
        AssistantToolRegistry,
        { provide: TicketsService, useValue: stubTickets },
        { provide: TicketLinksService, useValue: stubLinks },
        { provide: CommentsService, useValue: stubComments },
      ],
    }).compile();
    await module.init();
    registry = module.get(AssistantToolRegistry);
  });

  afterAll(async () => {
    await module.close();
  });

  it('AC-1: registers each ticket tool with its KODA_TOOL_DESCRIPTORS entry as its descriptor', () => {
    for (const name of TOOL_NAMES) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.descriptor).toBe(KODA_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name));
    }
  });

  it('AC-7: parse with { status: "BLOCKED" } refuses with reason status', () => {
    expect(reasonOf(() => search().parse({ status: 'BLOCKED' }))).toBe('status');
  });

  it('AC-8: parse with { text: "" } refuses with reason text', () => {
    expect(reasonOf(() => search().parse({ text: '' }))).toBe('text');
  });

  it('AC-13: parse with {} refuses with reason ref', () => {
    expect(reasonOf(() => get().parse({}))).toBe('ref');
  });

  it('parse keeps the filters it was given and defaults page to 1', () => {
    expect(search().parse({ status: 'IN_PROGRESS', type: 'BUG', priority: 'HIGH', assignee: 'me', text: 'login' })).toEqual({
      status: 'IN_PROGRESS', type: 'BUG', priority: 'HIGH', assignee: 'me', text: 'login', page: 1,
    });
    expect(search().parse({ page: 3 })).toEqual({ status: undefined, type: undefined, priority: undefined, assignee: undefined, text: undefined, page: 3 });
    expect(search().parse({})).toEqual({ status: undefined, type: undefined, priority: undefined, assignee: undefined, text: undefined, page: 1 });
  });

  it('parse refuses an unknown type, priority, assignee, page and an over-long text', () => {
    expect(reasonOf(() => search().parse({ type: 'STORY' }))).toBe('type');
    expect(reasonOf(() => search().parse({ priority: 'URGENT' }))).toBe('priority');
    expect(reasonOf(() => search().parse({ assignee: 'someone' }))).toBe('assignee');
    expect(reasonOf(() => search().parse({ page: 0 }))).toBe('page');
    expect(reasonOf(() => search().parse({ page: 1.5 }))).toBe('page');
    expect(reasonOf(() => search().parse({ text: 'x'.repeat(101) }))).toBe('text');
  });

  it('parse accepts the enum names the REST route accepts and a 100-character text', () => {
    expect(search().parse({ type: 'ENHANCEMENT', priority: 'CRITICAL', assignee: 'unassigned', text: 'x'.repeat(100) }))
      .toMatchObject({ type: 'ENHANCEMENT', priority: 'CRITICAL', assignee: 'unassigned' });
    expect(search().parse({ status: 'VERIFY_FIX' })).toMatchObject({ status: 'VERIFY_FIX' });
  });

  it('koda_get_ticket parse takes a KEY-N ref and refuses anything else', () => {
    expect(get().parse({ ref: 'WEB-12' })).toEqual({ ref: 'WEB-12' });
    expect(get().parse({ ref: 'W1-3' })).toEqual({ ref: 'W1-3' });
    // A CUID, a zero, a lowercase key and a bare number are all invalid_input: ref.
    expect(reasonOf(() => get().parse({ ref: 'clx0a1b2c3d4e5f6g7h8i' }))).toBe('ref');
    expect(reasonOf(() => get().parse({ ref: 'WEB-0' }))).toBe('ref');
    expect(reasonOf(() => get().parse({ ref: 'web-1' }))).toBe('ref');
    expect(reasonOf(() => get().parse({ ref: '1' }))).toBe('ref');
    expect(reasonOf(() => get().parse(null))).toBe('ref');
  });
});

// US-003 fix F1: the detail tool reads a ticket's comments through the bounded
// newest-10 service method; a ticket with a long history must not be loaded whole.
describe('koda_get_ticket execute (US-003 fix F1)', () => {
  const FENCE = '<<koda-data-0000000000000000>>';
  const ctx = {
    projectId: 'project-1',
    projectSlug: 'web',
    actor: { id: 'dev-1' },
    threadId: 'thread-1',
    jobId: 'job-1',
    now: new Date('2026-10-15T00:00:00.000Z'),
    data: (text: string) => `${FENCE}\n${text}\n<<end-koda-data-0000000000000000>>`,
  } as unknown as ToolContext;

  it('asks for the newest 10 comments and labels the result with the ticket total', async () => {
    const findRecentByTicket = vi.fn(async () => ({
      comments: Array.from({ length: 10 }, (_, index) => ({ id: `comment-${index + 3}`, body: `body ${index + 3}` })),
      total: 12,
    }));
    const tool = getTicketTool({
      tickets: {
        findByRef: vi.fn(async () => ({
          ref: 'WEB-1', status: 'IN_PROGRESS', priority: 'HIGH', type: 'BUG',
          title: 'Fix login page', description: null, assignee: null,
        })),
      } as unknown as TicketsService,
      links: { findByTicket: vi.fn(async () => []) } as unknown as TicketLinksService,
      comments: { findRecentByTicket } as unknown as CommentsService,
    });

    const content = await tool.execute(ctx, { ref: 'WEB-1' });

    expect(findRecentByTicket).toHaveBeenCalledWith('web', 'WEB-1', 10);
    expect(content).toContain('comments (last 10 of 12):');
    expect(content.match(/body \d+/g)).toEqual(Array.from({ length: 10 }, (_, index) => `body ${index + 3}`));
  });
});
