import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { TicketsService } from './tickets.service';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { parseBody } from '../approvals/route/parse-body';

function routeBody(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  return Object.hasOwn(source, key) ? source[key] : {};
}

export const TICKET_ROUTE_VARIANTS = {
  create: 'rest:tickets.create',
  update: 'rest:tickets.update',
  assign: 'rest:tickets.assign',
  delete: 'rest:tickets.delete',
} as const;

@Injectable()
export class TicketRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: TicketsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; ticket: CreateTicketDto }, TicketResponseDto>({
      key: 'ticket.create', variant: TICKET_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug } = parseRouteInput(input, ['slug']);
        const ticket = routeBody(input, 'ticket');
        return { slug, ticket: parseBody(CreateTicketDto, ticket) };
      },
      run: (principal, input) => this.service.create(input.slug, input.ticket, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; patch: UpdateTicketDto }, Awaited<ReturnType<TicketsService['update']>>>({
      key: 'ticket.update', variant: TICKET_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { slug, ref } = parseRouteInput(input, ['slug', 'ref']);
        const patch = routeBody(input, 'patch');
        return { slug, ref, patch: parseBody(UpdateTicketDto, patch) };
      },
      run: (principal, input) => this.service.update(input.slug, input.ref, input.patch, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; assignee: AssignTicketDto }, TicketResponseDto>({
      key: 'ticket.assign', variant: TICKET_ROUTE_VARIANTS.assign,
      parse: (input) => {
        const { slug, ref } = parseRouteInput(input, ['slug', 'ref']);
        const assignee = routeBody(input, 'assignee');
        return { slug, ref, assignee: parseBody(AssignTicketDto, assignee) };
      },
      run: (principal, input) => this.service.assign(input.slug, input.ref, input.assignee, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string }, Awaited<ReturnType<TicketsService['softDelete']>>>({
      key: 'ticket.delete', variant: TICKET_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug', 'ref']),
      run: (principal, input) => this.service.softDelete(input.slug, input.ref, principal),
      toResult: (result) => result,
    }, this.loader));
  }
}
