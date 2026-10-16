import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MemoryKind } from '../../../common/enums';
import { MEMORY_STATUSES } from '../../../memory/dto/list-memory.query';
import { MemoryGovernanceService } from '../../../memory/memory-governance.service';
import { decodeTimelineCursor } from '../../../memory/timeline-cursor';
import { TimelineService, type TimelineEvent } from '../../../memory/timeline.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { KnowledgeSearchService } from '../../knowledge/knowledge-search.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import {
  KODA_MEMORY_SEARCH,
  KODA_TIMELINE,
  TIMELINE_EVENT_TYPES,
  type TimelineEventType,
} from '../koda-tool-descriptors';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { getDocTool, kbSearchTool } from './kb-tools';

/**
 * Fleet S5b US-004/US-005/US-006: the knowledge read tools. The project is the thread's project (S5b-R7) — no tool takes a project
 * argument, and every read is scoped by `ctx.projectId`, so an item, an event or a document of another project can never be named.
 * Input is parsed by hand (1b-D5); the descriptor's `inputSchema` is what the model sees.
 */

/** Every list tool asks the API for one page of 20 (1b §Tool catalog). */
const PAGE_SIZE = 20;
const MAX_TEXT_CHARS = 100;
/** The memory statuses the REST list route accepts, in one place (`list-memory.query.ts`). */
type MemoryStatus = (typeof MEMORY_STATUSES)[number];

const DAY_MS = 86_400_000;
const DEFAULT_TIMELINE_DAYS = 7;
const MIN_TIMELINE_DAYS = 1;
const MAX_TIMELINE_DAYS = 90;
/** How long a cursor may be (1b §Tool catalog): its *shape* is judged by the module that made it. */
const MAX_CURSOR_CHARS = 200;
/** A ref is `PROJECTKEY-N`: the same rule `koda_get_ticket` applies, so the two tools never disagree on a ref. */
const TICKET_REF = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;

interface MemorySearchInput {
  text?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  page: number;
}

interface TimelineInput {
  ticket?: string;
  eventTypes?: TimelineEventType[];
  days: number;
  cursor?: string;
}

/** The input as a record; a missing key, a null and a non-object body all read as absent fields. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** An optional field that must be one of `allowed`; absent and null are both "not given". */
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new ToolInputError(reason);
  return value as T;
}

/** An optional 1- to 100-character text with at least one non-whitespace character: blank text is no search. */
function optionalText(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT_CHARS) throw new ToolInputError(reason);
  if (value.trim().length === 0) throw new ToolInputError(reason);
  return value;
}

/** An optional 1-based page number. */
function optionalPage(value: unknown, reason: string): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolInputError(reason);
  return value;
}

/** An optional integer inside `min`..`max`, defaulting when absent. */
function optionalInteger(value: unknown, min: number, max: number, fallback: number, reason: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ToolInputError(reason);
  return value;
}

/** An optional ticket ref: the tool resolves it through the project, so a typo is refused here, not answered. */
function optionalTicketRef(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !TICKET_REF.test(value)) throw new ToolInputError('ticket');
  return value;
}

/** An optional non-empty list of the timeline's own event types; every entry must be one of them. */
function optionalEventTypes(value: unknown): TimelineEventType[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new ToolInputError('eventTypes');
  for (const entry of value) {
    if (typeof entry !== 'string' || !(TIMELINE_EVENT_TYPES as readonly string[]).includes(entry)) {
      throw new ToolInputError('eventTypes');
    }
  }
  return value as TimelineEventType[];
}

/**
 * An optional 1- to 200-character cursor that `decodeTimelineCursor` accepts. The shape is judged here, in `parse`,
 * because the executor maps `ToolInputError` around `parse` only: a malformed cursor must be `invalid_input: cursor`
 * rather than the `error` a refusal from `TimelineService` would become.
 */
function optionalTimelineCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_CHARS) throw new ToolInputError('cursor');
  if (!decodeTimelineCursor(value)) throw new ToolInputError('cursor');
  return value;
}

/** The last line of a full page. */
const moreLine = (tool: string, nextPage: number): string => `more: call ${tool} with page ${nextPage}`;

/** `<subject> <predicate> <object>`, the object left out when the item has none. */
const memoryText = (item: { subject: string; predicate: string; object?: string }): string =>
  [item.subject, item.predicate, item.object].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');

/**
 * `koda_memory_search` (US-004): one page of the project's memory items, newest `updatedAt` first. Every user-written
 * field of an item — all three of `subject`, `predicate` and `object` — is fenced, so it can never read as
 * instructions. `status` is passed through only when given: without it the service applies its own default (active
 * and not expired by `ttlAt`).
 */
export function memorySearchTool(memory: MemoryGovernanceService): AssistantTool<MemorySearchInput> {
  return {
    descriptor: KODA_MEMORY_SEARCH,
    // 1b-D1: the memory REST routes are member-gated, so the tool declares membership rather than one ability.
    permission: { kind: 'member' },
    parse(input: unknown): MemorySearchInput {
      const raw = asRecord(input);
      return {
        text: optionalText(raw.text, 'text'),
        kind: optionalEnum(raw.kind, Object.values(MemoryKind), 'kind'),
        status: optionalEnum(raw.status, MEMORY_STATUSES, 'status'),
        page: optionalPage(raw.page, 'page'),
      };
    },
    async execute(ctx: ToolContext, input: MemorySearchInput): Promise<string> {
      const page = await memory.getProjectMemory(
        { projectId: ctx.projectId, text: input.text, kind: input.kind, status: input.status, orderBy: 'updatedAt' },
        { current: input.page, size: PAGE_SIZE },
      );
      if (page.records.length === 0) return 'no memory items';
      const lines: string[] = [];
      for (const item of page.records) {
        lines.push(
          `memory:${item.id} ${item.kind} ${item.status} confidence ${item.confidence.toFixed(2)} updated ${item.updatedAt.toISOString()}`,
        );
        lines.push(ctx.data(memoryText(item)));
      }
      if (page.hasNext) lines.push(moreLine(KODA_MEMORY_SEARCH.name, input.page + 1));
      return lines.join('\n');
    },
  };
}

/**
 * What every result names a ticket by: the web path a human can open (the ticket tools' own shape).
 */
const ticketPath = (slug: string, ref: string): string => `/${slug}/tickets/${ref}`;

/**
 * Every ticket of the page, resolved in one project-scoped read (US-005). The ids are deduplicated, so a page of 20
 * events of the same ticket still costs one lookup; a page with no ticket event at all reads nothing. A ticket that
 * no longer resolves — deleted, or (impossibly) of another project — is simply absent from the map.
 */
async function ticketRefs(
  tickets: TicketsService,
  projectId: string,
  events: readonly TimelineEvent[],
): Promise<Map<string, string>> {
  const ids = [...new Set(events.flatMap((event) => (event.ticketId === undefined ? [] : [event.ticketId])))];
  if (ids.length === 0) return new Map();
  return tickets.findRefsByIds(projectId, ids);
}

/**
 * `koda_timeline` (US-005): the project's timeline over a window ending at `ctx.now` — the executor's clock, so the
 * tool never reads the wall clock itself (the fleet spend tool's own rule). `ticket` is resolved through
 * `TicketsService.findByRef` first: a ref of another project or of no ticket at all raises `NotFoundAppException`,
 * which the executor answers as `not_found`, and the service is then asked for that ticket's events only. Every
 * event is a header line — its ISO time, its table, and, when the event's ticket still resolves, its ref and its web
 * path — followed by the fenced action. The tool never emits an actor (the service drops `actorType`).
 */
export function timelineTool(deps: { timeline: TimelineService; tickets: TicketsService }): AssistantTool<TimelineInput> {
  return {
    descriptor: KODA_TIMELINE,
    // 1b-D1: the timeline REST route is member-gated, so the tool declares membership rather than one ability.
    permission: { kind: 'member' },
    parse(input: unknown): TimelineInput {
      const raw = asRecord(input);
      return {
        ticket: optionalTicketRef(raw.ticket),
        eventTypes: optionalEventTypes(raw.eventTypes),
        days: optionalInteger(raw.days, MIN_TIMELINE_DAYS, MAX_TIMELINE_DAYS, DEFAULT_TIMELINE_DAYS, 'days'),
        cursor: optionalTimelineCursor(raw.cursor),
      };
    },
    async execute(ctx: ToolContext, input: TimelineInput): Promise<string> {
      // Scope first: `findByRef` is what turns a foreign or missing ref into not_found.
      const ticket = input.ticket === undefined ? undefined : await deps.tickets.findByRef(ctx.projectSlug, input.ticket);
      const page = await deps.timeline.getProjectTimeline({
        projectId: ctx.projectId,
        ...(ticket ? { ticketId: ticket.id } : {}),
        ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
        from: new Date(ctx.now.getTime() - input.days * DAY_MS),
        limit: PAGE_SIZE,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      if (page.events.length === 0) return 'no events';
      const refs = await ticketRefs(deps.tickets, ctx.projectId, page.events);
      const lines: string[] = [];
      for (const event of page.events) {
        const ref = event.ticketId === undefined ? undefined : refs.get(event.ticketId);
        const named = ref === undefined ? '' : ` ${ref} ${ticketPath(ctx.projectSlug, ref)}`;
        lines.push(`${event.createdAt.toISOString()} ${event.eventType}${named}`);
        lines.push(ctx.data(event.action));
      }
      if (page.nextCursor !== undefined) lines.push(`more: call ${KODA_TIMELINE.name} with cursor ${page.nextCursor}`);
      return lines.join('\n');
    },
  };
}

/** The S5b US-004/US-005/US-006 tool group (1b-D7): registers the knowledge tools with the registry at bootstrap. */
@Injectable()
export class KnowledgeTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly memory: MemoryGovernanceService,
    private readonly timeline: TimelineService,
    private readonly tickets: TicketsService,
    private readonly knowledge: KnowledgeSearchService,
    private readonly index: KnowledgeIndexService,
  ) {}

  onModuleInit(): void {
    const docs = { search: this.knowledge, index: this.index };
    this.registry.register(
      memorySearchTool(this.memory),
      timelineTool({ timeline: this.timeline, tickets: this.tickets }),
      kbSearchTool(docs),
      getDocTool(docs),
    );
  }
}
