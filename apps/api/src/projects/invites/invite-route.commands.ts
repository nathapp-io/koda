import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { parseBody } from '../../approvals/route/parse-body';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { ProjectInvitesService } from './project-invites.service';

import { CreateInviteDto } from './dto/create-invite.dto';
import type { InviteCreateResultDto, InviteResendResultDto } from './dto/invite.dto';

interface CreateInviteInput { slug: string; projectId: string; invite: CreateInviteDto; locale: string }
interface ResendInviteInput { slug: string; projectId: string; id: string; locale: string }

export const INVITE_ROUTE_VARIANTS = {
  create: 'rest:project-invites.create',
  resend: 'rest:project-invites.resend',
  cancel: 'rest:project-invites.cancel',
} as const;

@Injectable()
export class InviteRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly invites: ProjectInvitesService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CreateInviteInput, InviteCreateResultDto>({
      key: 'invite.create', variant: INVITE_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug, projectId } = parseRouteInput(input, ['slug', 'projectId']);
        const source = input as Record<string, unknown>;
        const locale = typeof source.locale === 'string' ? source.locale : 'en';
        return { slug, projectId, invite: parseBody(CreateInviteDto, source.invite ?? {}), locale };
      },
      redeem: { redact: ({ slug, projectId, invite }) => ({ slug, projectId, invite }) },
      run: (principal, input) => this.invites.create(input.slug, input.invite, principal, input.locale),
      toResult: ({ invitePath: _invitePath, ...result }) => result,
    }, this.loader));
    this.commands.register(routeCommand<ResendInviteInput, InviteResendResultDto>({
      key: 'invite.resend', variant: INVITE_ROUTE_VARIANTS.resend,
      parse: (input) => {
        const { slug, projectId, id } = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const source = input as Record<string, unknown>;
        const locale = typeof source.locale === 'string' ? source.locale : 'en';
        return { slug, projectId, id, locale };
      },
      redeem: { redact: ({ slug, projectId, id }) => ({ slug, projectId, id }) },
      run: (principal, input) => this.invites.resend(input.slug, input.id, principal, input.locale),
      toResult: ({ invitePath: _invitePath, ...result }) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; id: string }, null>({
      key: 'invite.cancel', variant: INVITE_ROUTE_VARIANTS.cancel,
      parse: (input) => parseRouteInput(input, ['slug', 'id']),
      run: async (principal, input) => {
        await this.invites.cancel(input.slug, input.id, principal);
        return null;
      },
    }, this.loader));
  }
}
