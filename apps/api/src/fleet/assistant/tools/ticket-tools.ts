import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommentsService } from '../../../comments/comments.service';
import { Priority, TicketStatus, TicketType } from '../../../common/enums';
import { TicketLinksService } from '../../../ticket-links/ticket-links.service';
import type { TicketLinkResponseDto } from '../../../ticket-links/dto/ticket-link-response.dto';
import type { CommentResponseDto } from '../../../comments/dto/comment-response.dto';
import { TicketsService, type TicketListFilterInput } from '../../../tickets/tickets.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { KODA_GET_TICKET, KODA_SEARCH_TICKETS } from '../koda-tool-descriptors';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';

/**
 * Fleet S5b US-003: the two ticket read tools. The project is the thread's project (S5b-R7) — neither tool takes a
 * project argument, and every ref is resolved through the project-scoped services, so a foreign ref is `not_found`.
 * Input is parsed by hand (1b-D5); the descriptor's `inputSchema` is what the model sees.
 */

/** Every list tool asks the API for one page of 20 (1b §Tool catalog). */
const PAGE_SIZE = 20;
const MAX_TEXT_CHARS = 100;
const LAST_COMMENTS = 10;
/** A ref is `PROJECTKEY-N`: `KEY-N` with an uppercase key and no leading zero (a CUID is invalid input). */
export const TICKET_REF = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;

interface SearchTicketsInput {
  status?: TicketStatus;
  type?: TicketType;
  priority?: Priority;
  assignee?: 'me' | 'unassigned';
  text?: string;
  page: number;
}

interface GetTicketInput {
  ref: string;
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

/** An optional title string of 1 to 100 characters. */
function optionalText(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT_CHARS) throw new ToolInputError(reason);
  return value;
}

/** An optional 1-based page number. */
function optionalPage(value: unknown, reason: string): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolInputError(reason);
  return value;
}

/** What every result names a ticket by: the web path a human can open. */
const ticketPath = (slug: string, ref: string): string => `/${slug}/tickets/${ref}`;

/** The last line of a full page. */
const moreLine = (tool: string, nextPage: number): string => `more: call ${tool} with page ${nextPage}`;

/** `<label>` on one line, the fence under it; `(none)` when the field has no value. */
function labelled(ctx: ToolContext, label: string, value: string | null | undefined): string[] {
  return value === undefined || value === null || value === '' ? [`${label}: (none)`] : [`${label}:`, ctx.data(value)];
}

/** One line per link (`linkType` and `prState`) with the URL fenced under it. */
function linkLines(ctx: ToolContext, links: readonly TicketLinkResponseDto[]): string[] {
  if (links.length === 0) return ['links: none'];
  const lines = ['links:'];
  for (const link of links) {
    lines.push(`- ${link.linkType} ${link.prState ?? 'none'}`);
    lines.push(ctx.data(link.url));
  }
  return lines;
}

/** The last 10 comment bodies, oldest first, each in its own fence; the header names a truncated history. */
function commentLines(ctx: ToolContext, comments: readonly CommentResponseDto[], total: number): string[] {
  if (comments.length === 0) return ['comments: none'];
  const lines = [comments.length === total ? 'comments:' : `comments (last ${LAST_COMMENTS} of ${total}):`];
  for (const comment of comments) lines.push(ctx.data(comment.body));
  return lines;
}

/**
 * `koda_search_tickets` (US-003): one page of the project's tickets. `assignee: 'me'` maps to the thread creator's
 * user id through the service's `assignedTo` filter; `unassigned` to both assignment columns being null.
 */
export function searchTicketsTool(tickets: TicketsService): AssistantTool<SearchTicketsInput> {
  return {
    descriptor: KODA_SEARCH_TICKETS,
    key: 'ticket.read',
    // 1b-D1: the CASL tuple the REST ticket routes enforce; every user holds it through READABLE_RESOURCES.
    permission: { kind: 'ability', action: 'read', subject: 'Ticket' },
    parse(input: unknown): SearchTicketsInput {
      const raw = asRecord(input);
      return {
        status: optionalEnum(raw.status, Object.values(TicketStatus), 'status'),
        type: optionalEnum(raw.type, Object.values(TicketType), 'type'),
        priority: optionalEnum(raw.priority, Object.values(Priority), 'priority'),
        assignee: optionalEnum(raw.assignee, ['me', 'unassigned'], 'assignee'),
        text: optionalText(raw.text, 'text'),
        page: optionalPage(raw.page, 'page'),
      };
    },
    async execute(ctx: ToolContext, input: SearchTicketsInput): Promise<string> {
      const filters: TicketListFilterInput = {
        status: input.status,
        type: input.type,
        priority: input.priority,
        titleContains: input.text,
        ...(input.assignee === 'me' ? { assignedTo: ctx.actor.id } : {}),
        ...(input.assignee === 'unassigned' ? { unassigned: true } : {}),
      };
      const page = await tickets.findAll(ctx.projectSlug, filters, { current: input.page, size: PAGE_SIZE });
      if (page.records.length === 0) return 'no tickets';
      const lines: string[] = [];
      for (const ticket of page.records) {
        lines.push(`${ticket.ref} ${ticket.status} ${ticket.priority} ${ticket.type} ${ticketPath(ctx.projectSlug, ticket.ref)}`);
        lines.push(ctx.data(ticket.title));
      }
      if (page.hasNext) lines.push(moreLine(KODA_SEARCH_TICKETS.name, input.page + 1));
      return lines.join('\n');
    },
  };
}

/**
 * `koda_get_ticket` (US-003): one ticket, its links and its last 10 comments. A ref of another project misses in
 * `TicketsService.findByRef` and raises `NotFoundAppException`, which the executor answers as `not_found`.
 */
export function getTicketTool(deps: { tickets: TicketsService; links: TicketLinksService; comments: CommentsService }): AssistantTool<GetTicketInput> {
  return {
    descriptor: KODA_GET_TICKET,
    key: 'ticket.read',
    permission: { kind: 'ability', action: 'read', subject: 'Ticket' },
    parse(input: unknown): GetTicketInput {
      const ref = asRecord(input).ref;
      if (typeof ref !== 'string' || !TICKET_REF.test(ref)) throw new ToolInputError('ref');
      return { ref };
    },
    async execute(ctx: ToolContext, input: GetTicketInput): Promise<string> {
      // Scope first: `findByRef` is what turns a foreign or missing ref into not_found.
      const ticket = await deps.tickets.findByRef(ctx.projectSlug, input.ref);
      const [links, recent] = await Promise.all([
        deps.links.findByTicket(ctx.projectSlug, input.ref),
        // F1: bounded — the newest 10 only, never the ticket's whole comment history.
        deps.comments.findRecentByTicket(ctx.projectSlug, input.ref, LAST_COMMENTS),
      ]);
      const lines = [
        `${ticket.ref} ${ticket.status} ${ticket.priority} ${ticket.type} ${ticketPath(ctx.projectSlug, ticket.ref)}`,
        // Only the kind and the id: the assignee's name is user-written and this tool does not fence it.
        `assignee: ${ticket.assignee ? `${ticket.assignee.kind} ${ticket.assignee.id}` : 'none'}`,
        ...labelled(ctx, 'title', ticket.title),
        ...labelled(ctx, 'description', ticket.description),
        ...linkLines(ctx, links),
        ...commentLines(ctx, recent.comments, recent.total),
      ];
      return lines.join('\n');
    },
  };
}

/** The US-003 tool group (1b-D7): registers the ticket tools with the registry at bootstrap. */
@Injectable()
export class TicketTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly tickets: TicketsService,
    private readonly links: TicketLinksService,
    private readonly comments: CommentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      searchTicketsTool(this.tickets),
      getTicketTool({ tickets: this.tickets, links: this.links, comments: this.comments }),
    );
  }
}
