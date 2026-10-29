import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { UsersAdminService } from './users-admin.service';
import { UpdateUserDto } from './dto/update-user.dto';

export const USER_ROUTE_VARIANTS = { update: 'rest:admin-users.update' } as const;

@Injectable()
export class UserRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly users: UsersAdminService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ id: string; patch: UpdateUserDto }, Awaited<ReturnType<UsersAdminService['update']>>>({
      key: 'user.update', variant: USER_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        const source = input as Record<string, unknown>;
        return { id, patch: parseBody(UpdateUserDto, source.patch ?? {}) };
      },
      run: (principal, input) => this.users.update(principal.id, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));
  }
}
