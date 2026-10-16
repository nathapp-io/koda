import { Test, type TestingModule } from '@nestjs/testing';
import type { IPageResult } from '@nathapp/nestjs-data';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { KODA_TOOL_LIMITS } from '@nathapp/fleet-protocol';
import { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { KnowledgeSearchService } from '../../knowledge/knowledge-search.service';
import { MemoryGovernanceService } from '../../../memory/memory-governance.service';
import type { MemoryItem } from '../../../memory/memory-item-repository';
import { encodeTimelineCursor } from '../../../memory/timeline-cursor';
import type { TimelineEvent, TimelineResponse } from '../../../memory/timeline.service';
import { TimelineService } from '../../../memory/timeline.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolInputError, type ToolContext } from '../assistant-tool.types';
import { KODA_TOOL_DESCRIPTORS, KNOWLEDGE_TOOL_DESCRIPTORS } from '../koda-tool-descriptors';
import { KnowledgeTools, memorySearchTool, timelineTool } from './knowledge-tools';

const TOOL_NAMES = ['koda_memory_search', 'koda_timeline'] as const;

/** The parser never touches the service, so the stub only satisfies the DI graph. */
const stubMemory = {} as MemoryGovernanceService;
const stubTimeline = {} as TimelineService;
const stubTickets = {} as TicketsService;
const stubSearch = {} as KnowledgeSearchService;
const stubIndex = {} as KnowledgeIndexService;

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

const FENCE_OPEN = '<<koda-data-0000000000000000>>';
const FENCE_CLOSE = '<<end-koda-data-0000000000000000>>';

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-15T00:00:00.000Z'),
  data: (text: string) => `${FENCE_OPEN}\n${text}\n${FENCE_CLOSE}`,
} as unknown as ToolContext;

const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-1',
  kind: 'FACT',
  subject: 'Deploy pipeline',
  predicate: 'status',
  object: 'green',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-15T00:00:00.000Z'),
  ...over,
});

const page = (records: MemoryItem[], over: Partial<IPageResult<MemoryItem>> = {}): IPageResult<MemoryItem> => ({
  records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over,
});

/** The tool under test, with the service's own page answer stubbed. */
const toolWith = (answer: IPageResult<MemoryItem>) => {
  const getProjectMemory = vi.fn(async () => answer);
  return { getProjectMemory, tool: memorySearchTool({ getProjectMemory } as unknown as MemoryGovernanceService) };
};

// The real registry, filled by KnowledgeTools.onModuleInit through Nest's lifecycle.
describe('knowledge tools (US-004)', () => {
  let module: TestingModule;
  let registry: AssistantToolRegistry;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        KnowledgeTools,
        AssistantToolRegistry,
        { provide: MemoryGovernanceService, useValue: stubMemory },
        { provide: TimelineService, useValue: stubTimeline },
        { provide: TicketsService, useValue: stubTickets },
        { provide: KnowledgeSearchService, useValue: stubSearch },
        { provide: KnowledgeIndexService, useValue: stubIndex },
      ],
    }).compile();
    await module.init();
    registry = module.get(AssistantToolRegistry);
  });

  afterAll(async () => {
    await module.close();
  });

  it('AC-1: registers each knowledge tool with its KODA_TOOL_DESCRIPTORS entry as its descriptor', () => {
    for (const name of TOOL_NAMES) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.descriptor).toBe(KODA_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name));
    }
    expect(KODA_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(expect.arrayContaining([...TOOL_NAMES]));
  });

  it('declares project membership as the permission of every knowledge tool', () => {
    for (const name of TOOL_NAMES) expect(registry.get(name)?.permission).toEqual({ kind: 'member' });
  });

  it('AC-1: the knowledge catalog names all four tools in order, and the catalog stays inside the tool limit', () => {
    expect(KNOWLEDGE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name))
      .toEqual(['koda_memory_search', 'koda_timeline', 'koda_kb_search', 'koda_get_doc']);
    expect(KODA_TOOL_DESCRIPTORS.length).toBeLessThanOrEqual(KODA_TOOL_LIMITS.maxTools);
    expect(new Set(KODA_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).size).toBe(KODA_TOOL_DESCRIPTORS.length);
  });

  it('AC-1: registers the two documentation tools with the catalog entries and member permission', () => {
    for (const name of ['koda_kb_search', 'koda_get_doc']) {
      const tool = registry.get(name);
      expect(tool?.descriptor).toBe(KODA_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name));
      expect(tool?.permission).toEqual({ kind: 'member' });
    }
  });

  it('AC-11: the parser refuses each invalid field with its own reason', () => {
    const tool = memorySearchTool(stubMemory);
    const cases: Array<[string, unknown, string]> = [
      ['an empty text', { text: '' }, 'text'],
      ['a whitespace-only text', { text: '   ' }, 'text'],
      ['a 101-character text', { text: 'x'.repeat(101) }, 'text'],
      ['an unknown kind', { kind: 'NOTE' }, 'kind'],
      ['an unknown status', { status: 'deleted' }, 'status'],
      ['page 0', { page: 0 }, 'page'],
      ['a fractional page', { page: 1.5 }, 'page'],
    ];
    for (const [label, input, reason] of cases) expect(reasonOf(() => tool.parse(input)), label).toBe(reason);
  });

  it('parse keeps the filters it was given and defaults page to 1', () => {
    const tool = memorySearchTool(stubMemory);
    expect(tool.parse({ text: 'deploy', kind: 'DECISION', status: 'superseded', page: 2 })).toEqual({
      text: 'deploy', kind: 'DECISION', status: 'superseded', page: 2,
    });
    expect(tool.parse({})).toEqual({ text: undefined, kind: undefined, status: undefined, page: 1 });
    expect(tool.parse(null)).toEqual({ text: undefined, kind: undefined, status: undefined, page: 1 });
    // The API's own spellings of kind, status, a 1-character and a 100-character text are all accepted.
    expect(tool.parse({ text: 'x' })).toMatchObject({ text: 'x' });
    expect(tool.parse({ text: 'x'.repeat(100) })).toMatchObject({ text: 'x'.repeat(100) });
    for (const kind of ['FACT', 'DECISION', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN']) {
      expect(tool.parse({ kind })).toMatchObject({ kind });
    }
    for (const status of ['active', 'superseded', 'rejected']) {
      expect(tool.parse({ status })).toMatchObject({ status });
    }
  });
});

describe('koda_memory_search execute (US-004)', () => {
  it('asks for the thread project newest-updatedAt first, one page of 20', async () => {
    const { getProjectMemory, tool } = toolWith(page([item()]));

    await tool.execute(ctx, tool.parse({ text: 'deploy', kind: 'FACT', status: 'active', page: 3 }));

    expect(getProjectMemory).toHaveBeenCalledWith(
      { projectId: 'project-1', text: 'deploy', kind: 'FACT', status: 'active', orderBy: 'updatedAt' },
      { current: 3, size: 20 },
    );
  });

  it('AC-7: each item is a header line and one fence holding subject, predicate and object', async () => {
    // 0.9 rather than a third decimal: `toFixed(2)` is the contract, and a value like 0.855 is not exact in binary.
    const { tool } = toolWith(page([item({ confidence: 0.9 })]));

    const content = await tool.execute(ctx, tool.parse({}));

    expect(content).toBe(
      [
        'memory:mem-1 FACT active confidence 0.90 updated 2026-10-15T00:00:00.000Z',
        FENCE_OPEN,
        'Deploy pipeline status green',
        FENCE_CLOSE,
      ].join('\n'),
    );
  });

  it('omits a null object from the fenced line', async () => {
    const { tool } = toolWith(page([item({ subject: 'ticket:2', predicate: 'in_progress_since', object: undefined })]));

    const content = await tool.execute(ctx, tool.parse({}));

    expect(content.split('\n').at(2)).toBe('ticket:2 in_progress_since');
  });

  it('AC-8: a full page ends with the next-page line', async () => {
    const records = Array.from({ length: 20 }, (_, index) => item({ id: `mem-${index}`, confidence: 0.5 }));
    const { tool } = toolWith(page(records, { total: 21, hasNext: true }));

    const lines = (await tool.execute(ctx, tool.parse({ page: 1 }))).split('\n');

    expect(lines.filter((line) => line.startsWith('memory:'))).toHaveLength(20);
    expect(lines.at(-1)).toBe('more: call koda_memory_search with page 2');
  });

  it('AC-9: no matching item answers the single line no memory items', async () => {
    const { tool } = toolWith(page([]));

    expect(await tool.execute(ctx, tool.parse({ page: 5 }))).toBe('no memory items');
  });
});

const DAY_MS = 86_400_000;
/** A cursor this module's own encoder produced — the only shape `parse` accepts. */
const CURSOR = encodeTimelineCursor({ createdAt: new Date('2026-10-13T00:00:00.000Z'), id: 'ev-19' });

/** A timeline event with every field the tool reads spelled out. */
const event = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: 'ev-1',
  eventType: 'ticket_event',
  actorId: 'dev-1',
  action: 'TICKET_CREATED',
  ticketId: 'ticket-3',
  createdAt: new Date('2026-10-14T00:00:00.000Z'),
  ...over,
});

/** The tool under test, with the timeline answer and the ticket reads stubbed. */
function timelineWith(answer: TimelineResponse, refs: Record<string, string> = {}) {
  const getProjectTimeline = vi.fn(async () => answer);
  const findRefsByIds = vi.fn(async () => new Map(Object.entries(refs)));
  const findByRef = vi.fn();
  const tool = timelineTool({
    timeline: { getProjectTimeline } as unknown as TimelineService,
    tickets: { findByRef, findRefsByIds } as unknown as TicketsService,
  });
  return { getProjectTimeline, findRefsByIds, findByRef, tool };
}

describe('koda_timeline parse (US-005)', () => {
  const tool = timelineTool({ timeline: stubTimeline, tickets: stubTickets });

  it('AC-12: the parser refuses each invalid field with its own reason', () => {
    const cases: Array<[string, unknown, string]> = [
      ['a lowercase ref', { ticket: 'sb-3' }, 'ticket'],
      ['a ref with no number', { ticket: 'WEB' }, 'ticket'],
      ['a ref with a leading zero', { ticket: 'WEB-03' }, 'ticket'],
      ['days 0', { days: 0 }, 'days'],
      ['days 91', { days: 91 }, 'days'],
      ['a fractional days', { days: 1.5 }, 'days'],
      ['an empty eventTypes', { eventTypes: [] }, 'eventTypes'],
      ['an unknown event type', { eventTypes: ['other'] }, 'eventTypes'],
      ['a non-array eventTypes', { eventTypes: 'ticket_event' }, 'eventTypes'],
      ['an empty cursor', { cursor: '' }, 'cursor'],
      ['a 201-character cursor', { cursor: 'x'.repeat(201) }, 'cursor'],
      ['a cursor this module never made', { cursor: 'not-a-cursor' }, 'cursor'],
    ];
    for (const [label, input, reason] of cases) expect(reasonOf(() => tool.parse(input)), label).toBe(reason);
  });

  it('keeps the filters it was given and defaults days to 7', () => {
    expect(tool.parse({ ticket: 'WEB-3', eventTypes: ['agent_event', 'decision_event'], days: 30, cursor: CURSOR })).toEqual({
      ticket: 'WEB-3',
      eventTypes: ['agent_event', 'decision_event'],
      days: 30,
      cursor: CURSOR,
    });
    expect(tool.parse({})).toEqual({ ticket: undefined, eventTypes: undefined, days: 7, cursor: undefined });
    expect(tool.parse(null)).toEqual({ ticket: undefined, eventTypes: undefined, days: 7, cursor: undefined });
    // The window bounds are inclusive: 1 and 90 are both usable.
    expect(tool.parse({ days: 1 })).toMatchObject({ days: 1 });
    expect(tool.parse({ days: 90 })).toMatchObject({ days: 90 });
    for (const eventType of ['ticket_event', 'agent_event', 'decision_event']) {
      expect(tool.parse({ eventTypes: [eventType] })).toMatchObject({ eventTypes: [eventType] });
    }
  });
});

describe('koda_timeline execute (US-005)', () => {
  it('asks the service for the thread project over the last 7 days, one page of 20', async () => {
    const { tool, getProjectTimeline } = timelineWith({ events: [] });

    await tool.execute(ctx, tool.parse({}));

    expect(getProjectTimeline).toHaveBeenCalledTimes(1);
    expect(getProjectTimeline).toHaveBeenCalledWith({
      projectId: 'project-1',
      from: new Date(ctx.now.getTime() - 7 * DAY_MS),
      limit: 20,
    });
  });

  it('AC-2: days moves the window the service is asked for', async () => {
    const { tool, getProjectTimeline } = timelineWith({ events: [] });

    await tool.execute(ctx, tool.parse({ days: 10 }));

    expect(getProjectTimeline).toHaveBeenCalledWith({
      projectId: 'project-1',
      from: new Date(ctx.now.getTime() - 10 * DAY_MS),
      limit: 20,
    });
  });

  it('AC-1: an event names its resolved ref and web path on the header line, then fences the action', async () => {
    const { tool, findRefsByIds } = timelineWith(
      { events: [event({ createdAt: new Date('2026-10-14T06:00:00.000Z'), action: 'TICKET_CREATED' })] },
      { 'ticket-3': 'WEB-3' },
    );

    const content = await tool.execute(ctx, tool.parse({}));

    expect(content).toBe(
      [
        '2026-10-14T06:00:00.000Z ticket_event WEB-3 /web/tickets/WEB-3',
        FENCE_OPEN,
        'TICKET_CREATED',
        FENCE_CLOSE,
      ].join('\n'),
    );
    // AC-13: every ticket of the page is resolved by one project-scoped read.
    expect(findRefsByIds).toHaveBeenCalledTimes(1);
    expect(findRefsByIds).toHaveBeenCalledWith('project-1', ['ticket-3']);
  });

  it('AC-10: an event whose ticket is not resolved is emitted without a ref or a path', async () => {
    const { tool } = timelineWith({ events: [event({ action: 'TICKET_DELETED' })] });

    const lines = (await tool.execute(ctx, tool.parse({}))).split('\n');

    expect(lines).toEqual([
      '2026-10-14T00:00:00.000Z ticket_event',
      FENCE_OPEN,
      'TICKET_DELETED',
      FENCE_CLOSE,
    ]);
  });

  it('resolves the page in one call, deduplicated, and never asks for an id of no event', async () => {
    const events = [
      event({ id: 'a' }),
      event({ id: 'b' }),
      event({ id: 'c', ticketId: 'ticket-9' }),
      event({ id: 'd', ticketId: undefined, eventType: 'agent_event' }),
    ];
    const { tool, findRefsByIds } = timelineWith({ events });

    await tool.execute(ctx, tool.parse({}));

    expect(findRefsByIds).toHaveBeenCalledTimes(1);
    expect(findRefsByIds).toHaveBeenCalledWith('project-1', ['ticket-3', 'ticket-9']);
  });

  it('emits no ref for a page of events without tickets, and still reads no refs', async () => {
    const events = [event({ id: 'a', eventType: 'agent_event', ticketId: undefined }), event({ id: 'b', eventType: 'decision_event', ticketId: undefined })];
    const { tool, findRefsByIds } = timelineWith({ events });

    const lines = (await tool.execute(ctx, tool.parse({}))).split('\n');

    expect(lines).toEqual([
      '2026-10-14T00:00:00.000Z agent_event',
      FENCE_OPEN,
      'TICKET_CREATED',
      FENCE_CLOSE,
      '2026-10-14T00:00:00.000Z decision_event',
      FENCE_OPEN,
      'TICKET_CREATED',
      FENCE_CLOSE,
    ]);
    expect(findRefsByIds).not.toHaveBeenCalled();
  });

  it('AC-6: eventTypes narrows the tables the service reads', async () => {
    const { tool, getProjectTimeline } = timelineWith({ events: [] });

    await tool.execute(ctx, tool.parse({ eventTypes: ['decision_event'] }));

    expect(getProjectTimeline).toHaveBeenCalledWith({
      projectId: 'project-1',
      eventTypes: ['decision_event'],
      from: new Date(ctx.now.getTime() - 7 * DAY_MS),
      limit: 20,
    });
  });

  it('AC-3: ticket resolves through findByRef first, and the service then reads that ticket only', async () => {
    const { tool, getProjectTimeline, findByRef, findRefsByIds } = timelineWith(
      { events: [event()] },
      { 'ticket-3': 'WEB-3' },
    );
    findByRef.mockResolvedValue({ id: 'ticket-3', ref: 'WEB-3' });

    await tool.execute(ctx, tool.parse({ ticket: 'WEB-3', eventTypes: ['ticket_event'] }));

    expect(findByRef).toHaveBeenCalledWith('web', 'WEB-3');
    expect(getProjectTimeline).toHaveBeenCalledWith({
      projectId: 'project-1',
      ticketId: 'ticket-3',
      eventTypes: ['ticket_event'],
      from: new Date(ctx.now.getTime() - 7 * DAY_MS),
      limit: 20,
    });
    // The header line is what proves the ref of the event's own ticket, not of the input ref.
    expect(findRefsByIds).toHaveBeenCalledWith('project-1', ['ticket-3']);
  });

  it('AC-4/AC-5: a missing or foreign ref propagates the service refusal the executor answers as not_found', async () => {
    const { tool, findByRef, getProjectTimeline } = timelineWith({ events: [] });
    const refusal = new NotFoundAppException({}, 'tickets');
    findByRef.mockRejectedValue(refusal);

    await expect(tool.execute(ctx, tool.parse({ ticket: 'OPS-1' }))).rejects.toBe(refusal);
    expect(getProjectTimeline).not.toHaveBeenCalled();
  });

  it('AC-8: a full page ends with the cursor line, and the next call passes that cursor back', async () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      event({ id: `ev-${index}`, createdAt: new Date(ctx.now.getTime() - (index + 1) * 60_000) }),
    );
    const { tool, getProjectTimeline } = timelineWith({ events, nextCursor: CURSOR }, { 'ticket-3': 'WEB-3' });

    const content = await tool.execute(ctx, tool.parse({}));

    expect(content.split('\n').filter((line) => line.endsWith('ticket_event WEB-3 /web/tickets/WEB-3'))).toHaveLength(20);
    expect(content.split('\n').at(-1)).toBe(`more: call koda_timeline with cursor ${CURSOR}`);

    await tool.execute(ctx, tool.parse({ cursor: CURSOR }));

    expect(getProjectTimeline).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      from: new Date(ctx.now.getTime() - 7 * DAY_MS),
      limit: 20,
      cursor: CURSOR,
    });
  });

  it('AC-11: an empty page answers the single line no events, without a ref read', async () => {
    const { tool, findRefsByIds, getProjectTimeline } = timelineWith({ events: [] });

    expect(await tool.execute(ctx, tool.parse({}))).toBe('no events');
    expect(getProjectTimeline).toHaveBeenCalledTimes(1);
    expect(findRefsByIds).not.toHaveBeenCalled();
  });
});
