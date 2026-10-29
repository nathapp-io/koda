import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { AddMemberDto } from './dto/add-member.dto';
import { ProjectMemberDto } from './dto/project-member.dto';
import { ProjectMembersService } from './project-members.service';

export const MEMBER_ROUTE_VARIANTS = { add: 'rest:project-members.add' } as const;

@Injectable()
export class MemberRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly members: ProjectMembersService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; member: AddMemberDto }, ProjectMemberDto>({
      key: 'member.add', variant: MEMBER_ROUTE_VARIANTS.add,
      parse: (input) => {
        const { slug } = parseRouteInput(input, ['slug']);
        const source = input as Record<string, unknown>;
        return { slug, member: parseBody(AddMemberDto, Object.hasOwn(source, 'member') ? source.member : {}) };
      },
      run: (principal, input) => this.members.add(input.slug, input.member, principal),
      toResult: (result) => result,
    }, this.loader));
  }
}
