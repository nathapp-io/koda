import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import { TicketsService } from './tickets.service';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { parseBody } from '../approvals/route/parse-body';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import { TICKET_EDGE_KEYS } from './state-machine/transition-keys';

function routeBody(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  return Object.hasOwn(source, key) ? source[key] : {};
}

export const TICKET_ROUTE_VARIANTS = {
  create: 'rest:tickets.create',
  update: 'rest:tickets.update',
  updateStatus: 'rest:tickets.update-status',
  assign: 'rest:tickets.assign',
  delete: 'rest:tickets.delete',
  verify: 'rest:tickets.verify',
  start: 'rest:tickets.start',
  fix: 'rest:tickets.fix',
  verifyFix: 'rest:tickets.verify-fix',
  close: 'rest:tickets.close',
  reject: 'rest:tickets.reject',
} as const;

@Injectable()
export class TicketRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: TicketsService,
    private readonly transitions: TicketTransitionsService,
    private readonly loader: ActorPrincipalLoader,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Whole-branch fix B1: the `ticket.update` half of a status PATCH's authority, re-checked where the
   * PATCH is executed.
   *
   * A status PATCH is gated under the edge key (`ticket.transition.start`) with `ticket.update` as a
   * companion key, so the gate applies the stricter of the two modes. Only the primary key is stored on
   * the request, and `ApprovalExecutionService` therefore re-checks the edge key alone; the route's
   * `@Requires('ticket.update')` covered the request that opened the approval, not the later execution.
   * `TicketsService.update`'s status branch checks edge authority only, so without this check a
   * `ticket.update` revoked while the request waited still let the parked PATCH — title and description
   * included — through. This runs before any write, on the immediate and the deferred path alike.
   */
  private async assertMayUpdate(principal: UserPrincipal | AgentPrincipal, slug: string, ref: string): Promise<void> {
    const ticket = await this.service.findByRef(slug, ref);
    const decision = await this.permissions.can(principal, 'ticket.update', { projectId: ticket.projectId });
    if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
  }

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
    const updateCommand = (key: string, variant: string, recheckUpdate = false) => routeCommand<{ slug: string; ref: string; patch: UpdateTicketDto }, Awaited<ReturnType<TicketsService['update']>>>({
      key, variant,
      parse: (input) => {
        const { slug, ref } = parseRouteInput(input, ['slug', 'ref']);
        const patch = routeBody(input, 'patch');
        return { slug, ref, patch: parseBody(UpdateTicketDto, patch) };
      },
      run: async (principal, input) => {
        if (recheckUpdate) await this.assertMayUpdate(principal, input.slug, input.ref);
        return this.service.update(input.slug, input.ref, input.patch, principal);
      },
      toResult: (result) => result,
    }, this.loader);
    this.commands.register(updateCommand('ticket.update', TICKET_ROUTE_VARIANTS.update));
    for (const key of TICKET_EDGE_KEYS) {
      this.commands.register(updateCommand(key, TICKET_ROUTE_VARIANTS.updateStatus, true));
    }
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
    this.commands.register(routeCommand<{ slug: string; ref: string; body: string }, Awaited<ReturnType<TicketTransitionsService['verify']>>['ticket']>({
      key: 'ticket.transition.verify', variant: TICKET_ROUTE_VARIANTS.verify,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'body']),
      run: async (principal, input) => (await this.transitions.verify(input.slug, input.ref, input.body, principal)).ticket,
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string }, Awaited<ReturnType<TicketTransitionsService['start']>>['ticket']>({
      key: 'ticket.transition.start', variant: TICKET_ROUTE_VARIANTS.start,
      parse: (input) => parseRouteInput(input, ['slug', 'ref']),
      run: async (principal, input) => (await this.transitions.start(input.slug, input.ref, principal)).ticket,
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; body: string }, Awaited<ReturnType<TicketTransitionsService['fix']>>['ticket']>({
      key: 'ticket.transition.fix', variant: TICKET_ROUTE_VARIANTS.fix,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'body']),
      run: async (principal, input) => (await this.transitions.fix(input.slug, input.ref, input.body, principal)).ticket,
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; body: string }, Awaited<ReturnType<TicketTransitionsService['verifyFix']>>['ticket']>({
      key: 'ticket.transition.verify-fix.approve', variant: TICKET_ROUTE_VARIANTS.verifyFix,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'body']),
      run: async (principal, input) => (await this.transitions.verifyFix(input.slug, input.ref, input.body, true, principal)).ticket,
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; body: string }, Awaited<ReturnType<TicketTransitionsService['verifyFix']>>['ticket']>({
      key: 'ticket.transition.verify-fix.return', variant: TICKET_ROUTE_VARIANTS.verifyFix,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'body']),
      run: async (principal, input) => (await this.transitions.verifyFix(input.slug, input.ref, input.body, false, principal)).ticket,
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; body: string }, Awaited<ReturnType<TicketTransitionsService['close']>>['ticket']>({
      key: 'ticket.transition.close', variant: TICKET_ROUTE_VARIANTS.close,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'body']),
      run: async (principal, input) => (await this.transitions.close(input.slug, input.ref, input.body, principal)).ticket,
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; body: string }, Awaited<ReturnType<TicketTransitionsService['reject']>>['ticket']>({
      key: 'ticket.transition.reject', variant: TICKET_ROUTE_VARIANTS.reject,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'body']),
      run: async (principal, input) => (await this.transitions.reject(input.slug, input.ref, input.body, principal)).ticket,
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
