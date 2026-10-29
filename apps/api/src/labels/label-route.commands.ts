import { parseBody } from '../approvals/route/parse-body';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { LabelsService } from './labels.service';

export const LABEL_ROUTE_VARIANTS = {
  create: 'rest:labels.create',
  update: 'rest:labels.update',
  assign: 'rest:ticket-labels.assign',
  delete: 'rest:labels.delete',
  remove: 'rest:ticket-labels.remove',
} as const;

@Injectable()
export class LabelRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: LabelsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; label: CreateLabelDto }, Awaited<ReturnType<LabelsService['create']>>>({
      key: 'label.create', variant: LABEL_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug } = parseRouteInput(input, ['slug']);
        return { slug, label: parseBody(CreateLabelDto, (input as Record<string, unknown>).label ?? {}) };
      },
      run: (principal, input) => this.service.create(input.slug, input.label, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; id: string; patch: UpdateLabelDto }, Awaited<ReturnType<LabelsService['update']>>>({
      key: 'label.update', variant: LABEL_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { slug, id } = parseRouteInput(input, ['slug', 'id']);
        return { slug, id, patch: parseBody(UpdateLabelDto, (input as Record<string, unknown>).patch ?? {}) };
      },
      run: (principal, input) => this.service.update(input.slug, input.id, input.patch, principal),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; assignment: AssignLabelDto }, Awaited<ReturnType<LabelsService['assignToTicket']>>>({
      key: 'ticket.label.assign', variant: LABEL_ROUTE_VARIANTS.assign,
      parse: (input) => {
        const { slug, ref } = parseRouteInput(input, ['slug', 'ref']);
        return { slug, ref, assignment: parseBody(AssignLabelDto, (input as Record<string, unknown>).assignment ?? {}) };
      },
      run: (principal, input) => this.service.assignToTicket(input.slug, input.ref, input.assignment, principal),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; id: string }, null>({
      key: 'label.delete', variant: LABEL_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug', 'id']),
      run: async (principal, input) => {
        await this.service.delete(input.slug, input.id, principal);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; labelId: string }, null>({
      key: 'ticket.label.remove', variant: LABEL_ROUTE_VARIANTS.remove,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'labelId']),
      run: async (principal, input) => {
        await this.service.removeFromTicket(input.slug, input.ref, input.labelId, principal);
        return null;
      },
    }, this.loader));
  }
}
