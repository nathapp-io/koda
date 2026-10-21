import { NotFoundAppException } from '@nathapp/nestjs-common';
import { Priority, TicketType } from '../../../common/enums';
import { CreateTicketDto } from '../../../tickets/dto/create-ticket.dto';
import { TicketsService } from '../../../tickets/tickets.service';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_CREATE_TICKETS } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { asRecord, ticketPath } from './tool-input';

/**
 * Fleet S5b 2b1 US-003 (2b1-D5 to D7): `koda_create_tickets` proposes 1 to 20 tickets and, once the user approves
 * the proposal, creates them one at a time in the order given. A preview never writes anything; `execute` is what an
 * approve runs, and it stops at the first ticket koda cannot create, quoting what it already wrote.
 */

/** 2b1-D5: how many tickets one call takes, and how long its text fields may be. The descriptor carries the same. */
const MAX_TICKETS = 20;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4_000;

const TICKET_TYPES: readonly string[] = Object.values(TicketType);
const PRIORITIES: readonly string[] = Object.values(Priority);

/** One proposed ticket, as the parser accepted it. The title and the description are kept as written. */
export interface TicketDraft {
  type: TicketType;
  title: string;
  description?: string;
  priority?: Priority;
}

export interface CreateTicketsInput {
  tickets: TicketDraft[];
}

const isTicketType = (value: unknown): value is TicketType =>
  typeof value === 'string' && TICKET_TYPES.includes(value);
const isPriority = (value: unknown): value is Priority =>
  typeof value === 'string' && PRIORITIES.includes(value);

/**
 * `koda_create_tickets` (2b1-D3): the batch of new tickets of the thread's project. `execute` creates them through
 * `TicketsService.create`, so each one carries the usual ticket event, timeline row and outbox event.
 */
export function createTicketsTool(deps: { tickets: TicketsService }): AssistantTool<CreateTicketsInput> {
  return {
    descriptor: KODA_CREATE_TICKETS,
    key: 'ticket.create',
    // 2b1-D4: the same CASL tuple the ticket create route enforces (`tickets.controller.ts`).
    permission: { kind: 'ability', action: 'create', subject: 'Ticket' },
    kind: 'write',
    parse(input: unknown): CreateTicketsInput {
      const tickets = asRecord(input)['tickets'];
      if (!Array.isArray(tickets) || tickets.length < 1 || tickets.length > MAX_TICKETS) {
        throw new ToolInputError('tickets');
      }
      // `i` is the zero-based index, and it names the field the refusal is about.
      return { tickets: tickets.map((ticket, i) => parseTicket(ticket, i)) };
    },
    /**
     * 2b1-D6: the text the user approves — the count, the project slug and one numbered line per ticket, with each
     * description line indented under it. The batch names no existing ticket, so it reads nothing; the whole text is
     * masked, because a description is user-written.
     */
    async preview(ctx: ToolContext, input: CreateTicketsInput): Promise<string> {
      const lines = [`Create ${input.tickets.length} ticket(s) in ${ctx.projectSlug}:`];
      input.tickets.forEach((ticket, i) => {
        lines.push(`${i + 1}. [${ticket.type}, ${ticket.priority ?? Priority.MEDIUM}] ${ticket.title}`);
        for (const line of descriptionLines(ticket.description)) lines.push(`    ${line}`);
      });
      return maskSecrets(lines.join('\n'));
    },
    /**
     * 2b1-D7: one `TicketsService.create` per ticket, in input order, as the requester with the action project's
     * role. The batch is not atomic: a failure stops it and the error quotes the lines already written (2b1-D2), so
     * the user learns exactly which tickets exist.
     */
    async execute(ctx: ToolContext, input: CreateTicketsInput): Promise<string> {
      const created: string[] = [];
      for (const [i, ticket] of input.tickets.entries()) {
        let ref: string;
        try {
          ref = (await deps.tickets.create(ctx.projectSlug, toDto(ticket), ctx.actor)).ref;
        } catch (error) {
          const reason = error instanceof NotFoundAppException ? 'not_found' : 'error';
          throw new ToolActionError([...created, `failed at ticket ${i + 1}: ${reason}`].join('\n'));
        }
        created.push(`created ${ref} ${ticketPath(ctx.projectSlug, ref)}`);
      }
      return created.join('\n');
    },
  };
}

/** One ticket of the batch, judged by 2b1-D5's bounds and refused with the field's own reason. */
function parseTicket(item: unknown, i: number): TicketDraft {
  const raw = asRecord(item);
  const type = raw['type'];
  if (!isTicketType(type)) throw new ToolInputError(`tickets[${i}].type`);
  const title = raw['title'];
  // The title is judged after trim, and kept as written (2b1-D5).
  if (typeof title !== 'string' || !withinChars(title, 1, MAX_TITLE_CHARS)) {
    throw new ToolInputError(`tickets[${i}].title`);
  }
  const description = optionalString(raw['description'], `tickets[${i}].description`, MAX_DESCRIPTION_CHARS);
  const priority = optionalPriority(raw['priority'], `tickets[${i}].priority`);
  return {
    type,
    title,
    ...(description === undefined ? {} : { description }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** An absent field, or a string judged after trim; anything else is the named refusal (2b1-D5). */
function optionalString(value: unknown, reason: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !withinChars(value, 0, maxChars)) throw new ToolInputError(reason);
  return value;
}

/** An absent field, or one of the four priorities; anything else is the named refusal (2b1-D5). */
function optionalPriority(value: unknown, reason: string): Priority | undefined {
  if (value === undefined) return undefined;
  if (!isPriority(value)) throw new ToolInputError(reason);
  return value;
}

/** 2b1-D5: the trimmed length is what is judged; the value itself is stored as written. */
const withinChars = (text: string, min: number, max: number): boolean => {
  const length = text.trim().length;
  return length >= min && length <= max;
};

/** The description's own lines; no description means no extra line. */
const descriptionLines = (description: string | undefined): string[] =>
  description === undefined ? [] : description.split('\n');

/** What the service takes: the parsed fields, in the order 2b1-D5 names them. */
function toDto(ticket: TicketDraft): CreateTicketDto {
  return {
    type: ticket.type,
    title: ticket.title,
    ...(ticket.description === undefined ? {} : { description: ticket.description }),
    ...(ticket.priority === undefined ? {} : { priority: ticket.priority }),
  };
}
