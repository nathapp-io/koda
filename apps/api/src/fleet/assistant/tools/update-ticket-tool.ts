import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { Priority, TicketStatus } from '../../../common/enums';
import { UpdateTicketDto } from '../../../tickets/dto/update-ticket.dto';
import { validateTransition } from '../../../tickets/state-machine/ticket-transitions';
import { TicketTransitionsService } from '../../../tickets/state-machine/ticket-transitions.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_UPDATE_TICKET } from '../koda-tool-descriptors';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { TICKET_REF } from './ticket-tools';
import { asRecord, ticketPath } from './tool-input';

/**
 * Fleet S5b 2b1 US-004 (2b1-D5 to D7): `koda_update_ticket` proposes one ticket's title, description, priority or
 * start move and, once the user approves the proposal, writes it as the requester. A preview never writes anything;
 * `execute` is what an approve runs, with the start prechecked against the ticket's status at that moment.
 */

/** 2b1-D5: the field bounds; the descriptor carries the same numbers. */
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4_000;
const PRIORITIES: readonly string[] = Object.values(Priority);

/** 2b-R3: the start move is the only status this tool sets — every other move needs a typed comment it does not take. */
const START_STATUS: TicketStatus = TicketStatus.IN_PROGRESS;

const isPriority = (value: unknown): value is Priority => typeof value === 'string' && PRIORITIES.includes(value);

/** One proposed change, as the parser accepted it. Every field is kept as written. */
export interface UpdateTicketInput {
  ref: string;
  title?: string;
  description?: string;
  priority?: Priority;
  status?: TicketStatus;
}

/**
 * `koda_update_ticket` (2b1-D3): one ticket of the thread's project. `execute` writes through
 * `TicketsService.update`, so the usual ticket event, timeline row and outbox event fire.
 */
export function updateTicketTool(deps: {
  tickets: TicketsService;
  transitions: TicketTransitionsService;
}): AssistantTool<UpdateTicketInput> {
  return {
    descriptor: KODA_UPDATE_TICKET,
    // 2b1-D4: the same CASL tuple the ticket PATCH route enforces (`tickets.controller.ts`).
    permission: { kind: 'ability', action: 'update', subject: 'Ticket' },
    kind: 'write',
    parse(input: unknown): UpdateTicketInput {
      const raw = asRecord(input);
      const ref = raw['ref'];
      // The ref rule of `koda_get_ticket` (1b-D5): a ticket ref, never an arbitrary id.
      if (typeof ref !== 'string' || !TICKET_REF.test(ref)) throw new ToolInputError('ref');
      const title = optionalString(raw['title'], 'title', 1, MAX_TITLE_CHARS);
      const description = optionalString(raw['description'], 'description', 0, MAX_DESCRIPTION_CHARS);
      const priority = optionalPriority(raw['priority']);
      const status = optionalStatus(raw['status']);
      if (title === undefined && description === undefined && priority === undefined && status === undefined) {
        throw new ToolInputError('changes');
      }
      return {
        ref,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(priority === undefined ? {} : { priority }),
        ...(status === undefined ? {} : { status }),
      };
    },
    /**
     * 2b1-D6: the text the user approves — the ticket it names, read through the project-scoped service, so a foreign
     * or missing ref raises `NotFoundAppException` and the executor answers `not_found` before any action exists.
     * Then one line per changed field, in the fixed order, and the whole text masked.
     */
    async preview(ctx: ToolContext, input: UpdateTicketInput): Promise<string> {
      const ticket = await deps.tickets.findByRef(ctx.projectSlug, input.ref);
      const lines = [`Update ${ticket.ref} "${ticket.title}" in ${ctx.projectSlug}:`];
      if (input.title !== undefined) lines.push(`title: ${ticket.title} -> ${input.title}`);
      if (input.description !== undefined) {
        lines.push('description:');
        for (const line of input.description.split('\n')) lines.push(`    ${line}`);
      }
      if (input.priority !== undefined) lines.push(`priority: ${ticket.priority} -> ${input.priority}`);
      if (input.status !== undefined) {
        // 2b1-D6: the ability first, so a requester without it answers `forbidden` whatever the ticket's status.
        await assertTransitionPermission(deps, ctx);
        if (!canStart(ticket.status as TicketStatus)) throw new ToolInputError('status');
        lines.push(`status: ${ticket.status} -> ${input.status}`);
      }
      return maskSecrets(lines.join('\n'));
    },
    /**
     * 2b1-D7: what an approve runs. A start reads the ticket first and refuses a move `validateTransition` has no
     * rule for — before any write — because the status may have changed since the proposal. Everything else is one
     * `TicketsService.update` as the requester with the action project's role.
     */
    async execute(ctx: ToolContext, input: UpdateTicketInput): Promise<string> {
      if (input.status !== undefined) {
        const ticket = await deps.tickets.findByRef(ctx.projectSlug, input.ref);
        if (!canStart(ticket.status as TicketStatus)) {
          throw new ToolActionError(`${input.ref} cannot move from ${ticket.status} to ${input.status}`);
        }
      }
      try {
        await deps.tickets.update(ctx.projectSlug, input.ref, toDto(input), ctx.actor);
      } catch (error) {
        // The service checks `transition` itself (Final-review Finding B), so its refusal is the same one the
        // preview would have raised; the action quotes the ability the requester is missing.
        if (error instanceof ForbiddenAppException) {
          throw new ToolActionError(`forbidden: ${input.ref} needs transition Ticket`);
        }
        throw error;
      }
      return `updated ${input.ref} ${ticketPath(ctx.projectSlug, input.ref)}`;
    },
  };
}

/**
 * `TicketsService.update` needs `transition` for a status change and answers `ForbiddenAppException` without it.
 * The tool re-checks it in the preview so the user is told before approving; the refusal is a `ToolForbiddenError`
 * (2b1-D1), which the executor words as `forbidden: koda_update_ticket needs transition Ticket on <slug>`.
 */
async function assertTransitionPermission(deps: { transitions: TicketTransitionsService }, ctx: ToolContext): Promise<void> {
  try {
    await deps.transitions.assertTransitionPermission(ctx.actor);
  } catch (error) {
    if (error instanceof ForbiddenAppException) throw new ToolForbiddenError('transition Ticket');
    throw error;
  }
}

/**
 * Whether the ticket's current status may move to `IN_PROGRESS` through the PATCH path, which carries no comment
 * type. `validateTransition` without a comment rejects every rule that needs one, so VERIFY_FIX (REVIEW), a terminal
 * status and a ticket already started all answer false.
 */
function canStart(from: TicketStatus): boolean {
  try {
    validateTransition(from, START_STATUS);
    return true;
  } catch {
    return false;
  }
}

/** An absent field, or a string judged after trim by its own bounds; anything else is the named refusal (2b1-D5). */
function optionalString(value: unknown, reason: string, minChars: number, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const length = typeof value === 'string' ? value.trim().length : -1;
  if (length < minChars || length > maxChars) throw new ToolInputError(reason);
  return value as string;
}

/** An absent field, or one of the four priorities; anything else is the named refusal (2b1-D5). */
function optionalPriority(value: unknown): Priority | undefined {
  if (value === undefined) return undefined;
  if (!isPriority(value)) throw new ToolInputError('priority');
  return value;
}

/** An absent field, or exactly the start status; every other status needs a typed comment this tool does not take. */
function optionalStatus(value: unknown): TicketStatus | undefined {
  if (value === undefined) return undefined;
  if (value !== START_STATUS) throw new ToolInputError('status');
  return START_STATUS;
}

/** What the service takes: the changed fields only — never the ref, which is the route's own argument (2b1-D7). */
function toDto(input: UpdateTicketInput): UpdateTicketDto {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}
