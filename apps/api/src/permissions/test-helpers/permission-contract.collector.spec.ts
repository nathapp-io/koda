/**
 * US-007: the runtime collector.
 *
 * The miniature Nest modules below are DB-free: the collector only reads Nest's own metadata and
 * the container's instance wrappers, so a testing module is enough. They live beside the helper
 * (not under `test/integration/`) so `bun run test` runs them without a database.
 */
import {
  Controller,
  Get,
  Injectable,
  Module,
  UseGuards,
  type Type,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { AssistantToolRegistry } from '../../fleet/assistant/assistant-tool.registry';
import type { AssistantTool } from '../../fleet/assistant/assistant-tool.types';
import { Requires } from '../requires.decorator';
import { RequiresGuard } from '../requires.guard';
import { PermissionService } from '../permission.service';
import { SystemWriter } from '../system-writer.decorator';
import { collectPermissionDeclarations, type PermissionDeclarations } from './permission-contract';

@Injectable()
@SystemWriter('system.outbox.retention')
class RetentionWriter {}

@Injectable()
@SystemWriter('system.outbox.retention')
class SecondRetentionWriter {}

@Controller('things')
@Requires('ticket.update')
class ThingController {
  @Get('read')
  @Requires('ticket.read')
  read(): void {}

  @Get('write')
  write(): void {}
}

@Controller('guarded')
@UseGuards(RequiresGuard)
class ClassGuardedController {
  @Get('one')
  one(): void {}
}

@Controller('handler-guarded')
class HandlerGuardedController {
  @Get('two')
  @UseGuards(RequiresGuard)
  two(): void {}
}

@Module({ providers: [RetentionWriter] })
class WriterModule {}

@Module({
  providers: [RetentionWriter, { provide: 'RETENTION_WRITER', useExisting: RetentionWriter }],
})
class AliasedWriterModule {}

@Module({
  providers: [RetentionWriter, SecondRetentionWriter],
})
class TwoWritersModule {}

@Module({ controllers: [ThingController] })
class RouteModule {}

@Module({
  controllers: [ClassGuardedController, HandlerGuardedController],
  // The guard is never called here; it only has to be injectable so the module compiles.
  providers: [{ provide: PermissionService, useValue: { can: async () => ({ allowed: false }) } }],
})
class GuardModule {}

const tool = (name: string, key: string): AssistantTool => ({
  descriptor: { name, description: 'd', inputSchema: {} },
  permission: { kind: 'member' },
  key,
  parse: (input) => input,
  execute: async () => 'ok',
});

describe('permission declaration collector', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  const build = async (imports: Type[]): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({ imports }).compile();
    return moduleRef;
  };

  const collect = (
    testingModule: TestingModule,
    registry: AssistantToolRegistry = new AssistantToolRegistry(),
  ): PermissionDeclarations =>
    collectPermissionDeclarations(testingModule.get(ModulesContainer), registry);

  it('AC-3: reports a provider class decorated with @SystemWriter', async () => {
    const testingModule = await build([WriterModule]);
    expect(collect(testingModule).systemWriters).toEqual([
      { writer: 'RetentionWriter', key: 'system.outbox.retention' },
    ]);
  });

  it('AC-4: reads handler Requires metadata first and falls back to the class', async () => {
    const testingModule = await build([RouteModule]);
    const { routes } = collect(testingModule);
    expect(routes).toHaveLength(2);
    const keySets = new Set(routes.map((route) => JSON.stringify(route.requires?.keys)));
    expect(keySets).toEqual(
      new Set([JSON.stringify(['ticket.read']), JSON.stringify(['ticket.update'])]),
    );
  });

  it('AC-5: lists the registered tools with their catalog keys', () => {
    const registry = new AssistantToolRegistry();
    registry.register(tool('koda_x', 'ticket.read'));
    const declarations = collectPermissionDeclarations(new ModulesContainer(), registry);
    expect(declarations.tools).toEqual([{ tool: 'koda_x', key: 'ticket.read' }]);
  });

  it('AC-9: reports a writer once when it is also aliased by a useExisting token', async () => {
    const testingModule = await build([AliasedWriterModule]);
    expect(collect(testingModule).systemWriters).toEqual([
      { writer: 'RetentionWriter', key: 'system.outbox.retention' },
    ]);
  });

  it('names a route "<METHOD> /<controller path>/<handler path>"', async () => {
    const testingModule = await build([RouteModule]);
    expect(collect(testingModule).routes.map((route) => route.route).sort()).toEqual([
      'GET /things/read',
      'GET /things/write',
    ]);
  });

  it('reports hasRequiresGuard for a class-level and for a handler-level guard', async () => {
    const testingModule = await build([GuardModule]);
    const { routes } = collect(testingModule);
    expect(routes).toHaveLength(2);
    for (const route of routes) expect(route.hasRequiresGuard).toBe(true);
  });

  it('reports hasRequiresGuard false for a route without the guard', async () => {
    const testingModule = await build([RouteModule]);
    for (const route of collect(testingModule).routes) {
      expect(route.hasRequiresGuard).toBe(false);
    }
  });

  it('reports both writer classes when two of them declare the same key', async () => {
    const testingModule = await build([TwoWritersModule]);
    expect(collect(testingModule).systemWriters).toEqual([
      { writer: 'RetentionWriter', key: 'system.outbox.retention' },
      { writer: 'SecondRetentionWriter', key: 'system.outbox.retention' },
    ]);
  });
});
