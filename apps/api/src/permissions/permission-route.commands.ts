import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { CreateRoleDto, RoleDto, UpdateRoleDto } from './dto/role.dto';
import type { RoleDomain } from './permissions.types';
import { RoleAdminService } from './role-admin.service';

/**
 * US-004: the REST entry points of the role writes, as engine commands.
 *
 * Each route registers its own variant under `role.manage`, so the engine runs the route's exact
 * input shape — the create body, `{ id, patch }` for a rename, `{ id }` for a delete — instead of the
 * key's primary command. The service calls inside `run` are the ones the handlers used to make, so a
 * deferred execution applies the same domain checks at the same place; they now run when the command
 * runs, and a failing check settles the request `failed`.
 */
export const PERMISSION_ROUTE_VARIANTS = {
  roleCreate: 'rest:roles.create',
  roleUpdate: 'rest:roles.update',
  roleDelete: 'rest:roles.delete',
} as const;

/** The catalog key every role write asks under. */
const ROLE_MANAGE = 'role.manage';

/** The `{ id, patch }` input the update route freezes: an id-addressed write with a body. */
interface RoleUpdateInput {
  id: string;
  patch: UpdateRoleDto;
}

/** The `{ id }` input the delete route freezes. */
interface RoleDeleteInput {
  id: string;
}

@Injectable()
export class PermissionRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly roles: RoleAdminService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CreateRoleDto, RoleDomain>({
      key: ROLE_MANAGE,
      variant: PERMISSION_ROUTE_VARIANTS.roleCreate,
      parse: (input) => parseBody(CreateRoleDto, input),
      run: (principal, input) => this.roles.createRole(principal, input),
      // The request's result holds what the route would have answered.
      toResult: (role) => RoleDto.from(role),
    }, this.loader));

    this.commands.register(routeCommand<RoleUpdateInput, RoleDomain>({
      key: ROLE_MANAGE,
      variant: PERMISSION_ROUTE_VARIANTS.roleUpdate,
      parse: (input) => {
        const { id } = parseIdInput(input);
        return { id, patch: parseBody(UpdateRoleDto, (input as { patch?: unknown }).patch) };
      },
      run: (principal, input) => this.roles.updateRole(principal, input.id, input.patch),
      toResult: (role) => RoleDto.from(role),
    }, this.loader));

    this.commands.register(routeCommand<RoleDeleteInput, null>({
      key: ROLE_MANAGE,
      variant: PERMISSION_ROUTE_VARIANTS.roleDelete,
      parse: (input) => ({ id: parseIdInput(input).id }),
      run: async (principal, input) => {
        await this.roles.deleteRole(principal, input.id);
        // Nothing to project: a delete answers no body.
        return null;
      },
    }, this.loader));
  }
}

/**
 * The `{ id }` an id-addressed route freezes: an object carrying a non-empty string `id`. Every other
 * member is dropped, so a body cannot smuggle a second instruction into the frozen input.
 */
export function parseIdInput(input: unknown): { id: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalidInput();
  const id = (input as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) throw invalidInput();
  return { id };
}

function invalidInput(): ValidationAppException {
  return new ValidationAppException({}, 'approvals.invalidInput');
}
