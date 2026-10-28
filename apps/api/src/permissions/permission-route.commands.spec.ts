/**
 * US-004 — the three role variants a REST route registers on the approval engine.
 *
 * The commands are the engine's view of `POST/PATCH/DELETE /roles`: each one parses the input the
 * route froze, and runs the same service method the route used to call directly.
 */
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry, type ApprovalCommand } from '../approvals/approval-command.registry';
import type { AgentPrincipal } from '../auth/principal/koda-principal.types';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { PERMISSION_ROUTE_VARIANTS, PermissionRouteCommands } from './permission-route.commands';
import type { RoleAdminService } from './role-admin.service';
import type { RoleDomain } from './permissions.types';

const agent: AgentPrincipal = {
  actorType: 'agent', id: 'agent-1', name: 'qa-agent', slug: 'qa-agent', status: 'ACTIVE',
  capabilities: [], blacklisted: false, revoked: false, authorities: [], extra: { slug: 'qa-agent' },
};

const createdRole: RoleDomain = {
  id: 'role-1', key: 'qa', name: 'QA', description: '', scope: 'GLOBAL',
  system: false, locked: false, permissions: ['role.read'],
};

interface Harness {
  registry: ApprovalCommandRegistry;
  roles: { createRole: ReturnType<typeof vi.fn>; updateRole: ReturnType<typeof vi.fn>; deleteRole: ReturnType<typeof vi.fn> };
  loader: { forContext: ReturnType<typeof vi.fn> };
}

function build(): Harness {
  const registry = new ApprovalCommandRegistry();
  const roles = {
    createRole: vi.fn(async () => createdRole),
    updateRole: vi.fn(async () => ({ ...createdRole, name: 'Renamed' })),
    deleteRole: vi.fn(async () => undefined),
  };
  const loader = { forContext: vi.fn(async () => agent) };
  const commands = new PermissionRouteCommands(
    registry,
    roles as unknown as RoleAdminService,
    loader as unknown as ActorPrincipalLoader,
  );
  commands.onModuleInit();
  return { registry, roles, loader };
}

/** The registered command for one role variant; a missing registration fails the test, not the read. */
function commandOf(registry: ApprovalCommandRegistry, variant: string): ApprovalCommand {
  const command = registry.get('role.manage', variant);
  if (command === undefined) throw new Error(`no command registered for role.manage#${variant}`);
  return command;
}

/** What `parse` threw; null when it parsed. */
function errorOf(command: ApprovalCommand, input: unknown): unknown {
  try {
    command.parse(input);
    return null;
  } catch (error) {
    return error;
  }
}

function expectInvalidInput(command: ApprovalCommand, input: unknown): void {
  const error = errorOf(command, input);

  expect(error).toBeInstanceOf(ValidationAppException);
  expect((error as ValidationAppException).prefix).toBe('approvals.invalidInput');
}

describe('PermissionRouteCommands', () => {
  it('registers the three role variants under role.manage', () => {
    const { registry } = build();

    for (const variant of Object.values(PERMISSION_ROUTE_VARIANTS)) {
      expect(commandOf(registry, variant)).toMatchObject({ key: 'role.manage', variant });
    }
    expect(registry.get('role.manage')).toBeUndefined();
  });

  it('parses the create body and creates the role as the context principal', async () => {
    const { registry, roles, loader } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleCreate);
    const body = { key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'], extra: 1 };

    const parsed = command.parse(body);
    expect(parsed).toEqual({ key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] });

    await expect(command.execute(parsed)).resolves.toBe(createdRole);
    expect(loader.forContext).toHaveBeenCalledTimes(1);
    expect(roles.createRole).toHaveBeenCalledWith(agent, parsed);
  });

  it('stores the created role DTO as the request result', async () => {
    const { registry } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleCreate);

    expect(command.toResult?.(createdRole)).toEqual({
      id: 'role-1', key: 'qa', name: 'QA', description: '', scope: 'GLOBAL',
      system: false, locked: false, permissions: ['role.read'], expandedKeys: ['role.read'],
    });
  });

  it('refuses a body the CreateRoleDto rejects as approvals.invalidInput', () => {
    const { registry } = build();

    expectInvalidInput(commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleCreate), {
      name: 'QA', scope: 'GLOBAL', permissions: [],
    });
  });

  it('freezes { id, patch } for the update and parses the patch as UpdateRoleDto', async () => {
    const { registry, roles, loader } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleUpdate);

    const parsed = command.parse({ id: 'role-1', patch: { name: 'Renamed', key: 'qa', extra: 1 } });
    expect(parsed).toEqual({ id: 'role-1', patch: { name: 'Renamed' } });

    await command.execute(parsed);
    expect(loader.forContext).toHaveBeenCalledTimes(1);
    expect(roles.updateRole).toHaveBeenCalledWith(agent, 'role-1', { name: 'Renamed' });
  });

  it('stores the updated role DTO as the request result', async () => {
    const { registry } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleUpdate);

    expect(command.toResult?.({ ...createdRole, name: 'Renamed' })).toMatchObject({ id: 'role-1', name: 'Renamed' });
  });

  it('refuses an update whose id is not a non-empty string, and a patch the DTO rejects', () => {
    const { registry } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleUpdate);

    for (const input of [{}, { id: '' }, { id: 42 }, { id: 'role-1' }, { id: null, patch: { name: 'x' } }, null, [], 'role-1']) {
      expectInvalidInput(command, input);
    }
    expectInvalidInput(command, { id: 'role-1', patch: { name: '' } });
  });

  it('freezes { id } for the delete and drops every other member', () => {
    const { registry } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleDelete);

    expect(command.parse({ id: 'role-1', name: 'Renamed', patch: { name: 'x' } })).toEqual({ id: 'role-1' });
  });

  it('deletes the role and answers null for the request result', async () => {
    const { registry, roles, loader } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleDelete);

    await expect(command.execute({ id: 'role-1' })).resolves.toBeNull();
    expect(loader.forContext).toHaveBeenCalledTimes(1);
    expect(roles.deleteRole).toHaveBeenCalledWith(agent, 'role-1');
    // Nothing to project: the engine stores null for a command with no `toResult`.
    expect(command.toResult).toBeUndefined();
  });

  it('refuses a delete whose id is not a non-empty string', () => {
    const { registry } = build();
    const command = commandOf(registry, PERMISSION_ROUTE_VARIANTS.roleDelete);

    for (const input of [{}, { id: '' }, { id: { nested: true } }, null, [], 7]) expectInvalidInput(command, input);
  });
});
