import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { McpController } from '../fleet/assistant/mcp/mcp.controller';
import { ThreadEventsController } from '../fleet/threads/thread-events.controller';
import { WorkspaceThreadEventsController } from '../fleet/threads/workspace-thread-events.controller';
import { HealthController } from '../health/health.controller';
import { LiveController } from '../live/live.controller';
import { MeLiveController } from '../live/me-live.controller';
import { MemoryController } from '../memory/memory.controller';
import { RoleBindingsController } from './role-bindings.controller';
import { RolesController } from './roles.controller';
import { RequiresGuard } from './requires.guard';
import { REQUIRES_METADATA, type RequiresMetadata } from './requires.decorator';

const declarations: ReadonlyArray<readonly [object, string, readonly string[], 'all' | 'any', 'guard' | 'service']> = [
  [McpController, 'post', ['mcp.access'], 'all', 'guard'],
  [McpController, 'get', ['mcp.access'], 'all', 'guard'],
  [McpController, 'delete', ['mcp.access'], 'all', 'guard'],
  [HealthController, 'check', ['health.read'], 'all', 'guard'],
  [ThreadEventsController, 'events', ['thread.read'], 'all', 'service'],
  [WorkspaceThreadEventsController, 'events', ['thread.workspace.read'], 'all', 'guard'],
  [LiveController, 'events', ['project.read'], 'all', 'service'],
  [MeLiveController, 'events', ['notification.read'], 'all', 'service'],
  [RolesController, 'list', ['role.read'], 'all', 'service'],
  [RolesController, 'create', ['role.manage'], 'all', 'service'],
  [RolesController, 'update', ['role.manage'], 'all', 'service'],
  [RolesController, 'remove', ['role.manage'], 'all', 'service'],
  [RoleBindingsController, 'list', ['role.read'], 'all', 'service'],
  [RoleBindingsController, 'create', ['role.binding.manage', 'role.binding.global', 'role.binding.owner'], 'any', 'service'],
  [RoleBindingsController, 'remove', ['role.binding.manage', 'role.binding.global', 'role.binding.owner'], 'any', 'service'],
  [MemoryController, 'createMemory', ['memory.create', 'memory.update'], 'all', 'service'],
  [MemoryController, 'recordDecision', ['memory.decision.record', 'memory.update'], 'all', 'service'],
];

describe('remaining route permission declarations', () => {
  const reflector = new Reflector();

  it('AC-1: declares keys, mode and enforcement for every specified handler', () => {
    for (const [controller, name, keys, mode, enforcedBy] of declarations) {
      const handler = (controller as { prototype: Record<string, unknown> }).prototype[name];
      expect(reflector.get<RequiresMetadata>(REQUIRES_METADATA, handler as object)).toEqual({ keys, mode, enforcedBy });
    }
  });

  it('AC-2: MCP and health routes all register RequiresGuard', () => {
    for (const [controller, name] of declarations.slice(0, 4)) {
      const prototype = (controller as { prototype: Record<string, unknown> }).prototype;
      const handler = prototype[name] as object;
      const guards = [
        ...(Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined ?? []),
        ...(Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined ?? []),
      ];
      expect(guards, `${controller.constructor.name}.${name}`).toContain(RequiresGuard);
    }
  });
});
