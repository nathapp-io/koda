import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { UsersAdminService } from './users-admin.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export const USER_ROUTE_VARIANTS = {
  create: 'rest:admin-users.create',
  update: 'rest:admin-users.update',
} as const;

/**
 * The body property a create-shaped route input carries. A non-object input answers `undefined`, and a
 * missing property `{}`: both are refused by `parseBody`, which needs an object to validate.
 */
function routeBody(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  return Object.hasOwn(source, key) ? source[key] : {};
}

@Injectable()
export class UserRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly users: UsersAdminService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    // `gate-secret` (US-007): the temporary password the admin sets is a credential, so the request
    // stores only the identity it creates. Approving it runs nothing; the requester redeems it by
    // re-sending the body, and the password that lands is the one in that re-sent body — which is why
    // only email and name are bound into the stored hash.
    this.commands.register(routeCommand<{ user: CreateUserDto }, Awaited<ReturnType<UsersAdminService['create']>>>({
      key: 'user.create', variant: USER_ROUTE_VARIANTS.create,
      parse: (input) => ({ user: parseBody(CreateUserDto, routeBody(input, 'user')) }),
      redeem: { redact: ({ user }) => ({ user: { email: user.email, name: user.name } }) },
      // bcrypt (cost 12) is deliberately slow, so it runs in the preparation, outside the execution
      // transaction; the callback it answers is the write. The immediate path's `create` prepares too.
      prepare: (_principal, input) => this.users.prepareCreate(input.user),
      run: (_principal, input) => this.users.create(input.user),
      toResult: (result) => result,
    }, this.loader));
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
