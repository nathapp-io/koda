import { ForbiddenAppException, NotFoundAppException, ValidationAppException, JsonResponse } from '@nathapp/nestjs-common';
import { MemoryController } from './memory.controller';
import { MemoryWriteService } from './memory-write.service';
import { MemoryRouteCommands } from './memory-route.commands';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { ApprovalRouteGate, type RouteGateCall } from '../approvals/route/approval-route-gate';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { MemoryWriteGuard } from './memory-write.guard';
import { MemoryKind } from '../common/enums';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

const makePrincipal = (id = 'user-1'): UserPrincipal => ({
  actorType: 'user', id, name: undefined, blacklisted: false, revoked: false,
  authorities: [], role: 'ADMIN' as UserPrincipal['role'], email: `${id}@example.test`,
});

function setupController() {
  let activePrincipal: KodaPrincipal = makePrincipal();
  const item = {
    id: 'memory-1', projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p', object: 'value',
    status: 'active', confidence: 0.8, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const extraction = {
    extractFromEvent: vi.fn().mockReturnValue([]),
    recordDecision: vi.fn().mockResolvedValue({ canonicalId: 'canonical-1', memoryId: 'memory-1' }),
  };
  const repository = {
    upsert: vi.fn().mockResolvedValue(item),
    findActive: vi.fn().mockResolvedValue(null),
    ticketInProject: vi.fn().mockResolvedValue(true),
  };
  const projectAccess = { assertProjectMembership: vi.fn().mockResolvedValue(undefined) };
  const permissions = {
    can: vi.fn(async (_actor: unknown, key: string, context?: { projectId?: string; resource?: unknown }) => {
      if (context?.resource) return { allowed: false, reason: 'not-granted' };
      if (key === 'memory.update' && context?.projectId === undefined) return { allowed: false, reason: 'not-granted' };
      return { allowed: true, reason: 'granted' };
    }),
  };
  const writeGuard = new MemoryWriteGuard(permissions as unknown as PermissionService, repository as unknown as PrismaMemoryItemRepository);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const writes = new MemoryWriteService(
    extraction as unknown as ExtractionService,
    repository as unknown as PrismaMemoryItemRepository,
    projectAccess as unknown as ProjectAccessService,
    permissions as unknown as PermissionService,
    writeGuard,
    audit as unknown as AuditRecorder,
  );
  const registry = new ApprovalCommandRegistry();
  const loader = { forContext: vi.fn(async () => activePrincipal) };
  new MemoryRouteCommands(registry, writes, loader as unknown as ActorPrincipalLoader).onModuleInit();
  const gate = {
    run: vi.fn(async <T>(call: RouteGateCall) => {
      const command = registry.get(call.key, call.variant);
      if (!command) throw new Error(`missing command ${call.key}/${call.variant}`);
      const parsed = command.parse(call.input);
      return { status: 'executed' as const, result: await command.execute(parsed) as T };
    }),
  };
  const controller = new MemoryController(writes, gate as unknown as ApprovalRouteGate);
  const invoke = async <T>(principal: KodaPrincipal, action: () => Promise<T>): Promise<T> => {
    activePrincipal = principal;
    return action();
  };

  return { controller, extraction, repository, projectAccess, permissions, audit, gate, invoke, item };
}

describe('MemoryController gated writes', () => {
  it('AC-10 calls routeGate.run for create with the dto project and body', async () => {
    const input = { projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p' };
    const run = vi.fn().mockResolvedValue({ status: 'executed', result: { id: 'memory-1' } });
    const controller = new MemoryController({} as MemoryWriteService, { run } as unknown as ApprovalRouteGate);

    await controller.createMemory(input, makePrincipal());

    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'memory.create', variant: 'rest:memory.create', projectId: 'p1', input: { memory: input } });
  });

  it('create executes the real write command, returns its result, and attributes ownership to the principal', async () => {
    const { controller, repository, invoke, item } = setupController();
    const principal = makePrincipal('writer-1');
    const input = { projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p', ownerId: 'forged' };

    const result = await invoke(principal, () => controller.createMemory(input, principal));

    expect(result).toEqual(JsonResponse.Ok(item));
    expect(repository.upsert).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'writer-1', ownerType: 'USER' }), expect.anything());
  });

  it('create honors privileged attribution and reports the exact gate call', async () => {
    const { controller, repository, permissions, gate, invoke, item } = setupController();
    permissions.can.mockImplementation(async () => ({ allowed: true, reason: 'granted' }));
    const principal = makePrincipal('global-writer');
    const input = { projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p', ownerId: 'chosen-owner' };

    const result = await invoke(principal, () => controller.createMemory(input, principal));

    expect(result).toEqual(JsonResponse.Ok(item));
    expect(repository.upsert).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'chosen-owner', ownerType: null }), expect.anything());
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'memory.create', variant: 'rest:memory.create', projectId: 'p1', input: { memory: input } });
  });

  it('create records agent attribution as AGENT', async () => {
    const { controller, repository, invoke, item } = setupController();
    const principal: KodaPrincipal = { actorType: 'agent', id: 'agent-7', slug: 'agent-seven', status: 'ACTIVE', capabilities: [], blacklisted: false, revoked: false, authorities: [], name: undefined };
    const input = { projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p' };

    const result = await invoke(principal, () => controller.createMemory(input, principal));

    expect(result).toEqual(JsonResponse.Ok(item));
    expect(repository.upsert).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'agent-7', ownerType: 'AGENT' }), expect.anything());
  });

  it('create runs replacement authorization and the audit hook through the real service', async () => {
    const { controller, repository, permissions, audit, invoke, item } = setupController();
    repository.upsert.mockImplementation(async (_input: unknown, options?: { beforeSupersede?: (existing: typeof item) => Promise<void>; onWritten?: (written: { item: typeof item; superseded: null }) => Promise<void> }) => {
      await options?.beforeSupersede?.({ ...item, ownerId: 'other', ownerType: 'USER' });
      await options?.onWritten?.({ item, superseded: null });
      return item;
    });
    permissions.can.mockImplementation(async (_actor, key, context) =>
      context?.resource ? { allowed: true, reason: 'granted' } : key === 'memory.update' ? { allowed: false, reason: 'not-granted' } : { allowed: true, reason: 'granted' });
    const principal = makePrincipal();

    await invoke(principal, () => controller.createMemory({ projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p' }, principal));

    expect(permissions.can).toHaveBeenCalledWith(principal, 'memory.update', expect.objectContaining({ projectId: 'p1', resource: expect.anything() }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'memory.create', resourceId: item.id }));
  });

  it('create propagates real service validation failures without writing', async () => {
    const { controller, repository, invoke } = setupController();
    const principal = makePrincipal();
    await expect(invoke(principal, () => controller.createMemory({ projectId: 'p1', kind: MemoryKind.DECISION, subject: 's', predicate: 'p' }, principal)))
      .rejects.toBeInstanceOf(ValidationAppException);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('recordDecision executes the matching service method with caller attribution and passes its result through', async () => {
    const { controller, extraction, gate, invoke } = setupController();
    const principal = makePrincipal('decision-writer');
    const decision = { projectId: 'p1', actorId: 'spoofed', topic: 'architecture', decision: 'keep it simple' };

    const result = await invoke(principal, () => controller.recordDecision(decision, principal));

    expect(result).toEqual(JsonResponse.Ok({ canonicalId: 'canonical-1', memoryId: 'memory-1' }));
    expect(extraction.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'decision-writer', topic: 'architecture' }), expect.anything(), expect.anything());
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({
      key: 'memory.decision.record', variant: 'rest:memory.decisions.record', projectId: 'p1', input: { decision },
    });
  });

  it('recordDecision honors privileged actor attribution and records replacement audit hooks', async () => {
    const { controller, extraction, permissions, audit, gate, invoke } = setupController();
    permissions.can.mockImplementation(async () => ({ allowed: true, reason: 'granted' }));
    extraction.recordDecision.mockImplementation(async (input: unknown, _repository: unknown, options?: { beforeSupersede?: (existing: { id: string }) => Promise<void>; onWritten?: (written: { item: { id: string; kind: string }; superseded: null }) => Promise<void> }) => {
      await options?.beforeSupersede?.({ id: 'prior-decision' });
      await options?.onWritten?.({ item: { id: 'new-decision', kind: MemoryKind.DECISION }, superseded: null });
      return { canonicalId: 'new-decision', memoryId: 'new-decision' };
    });
    const principal = makePrincipal('privileged-writer');
    const decision = { projectId: 'p1', actorId: 'chosen-actor', topic: 'architecture', decision: 'approved' };

    const result = await invoke(principal, () => controller.recordDecision(decision, principal));

    expect(result).toEqual(JsonResponse.Ok({ canonicalId: 'new-decision', memoryId: 'new-decision' }));
    expect(extraction.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'chosen-actor', ownerType: null }), expect.anything(), expect.objectContaining({ beforeSupersede: expect.any(Function), onWritten: expect.any(Function) }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'memory.decision.record', resourceId: 'new-decision' }));
    expect(permissions.can).toHaveBeenCalledWith(principal, 'memory.update', expect.objectContaining({ projectId: 'p1', resource: expect.anything() }));
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'memory.decision.record', variant: 'rest:memory.decisions.record', projectId: 'p1', input: { decision } });
  });

  it('recordDecision propagates a real service failure', async () => {
    const { controller, extraction, invoke } = setupController();
    const principal = makePrincipal();
    const failure = new Error('decision write failed');
    extraction.recordDecision.mockRejectedValue(failure);
    await expect(invoke(principal, () => controller.recordDecision({ projectId: 'p1', topic: 't', decision: 'd' }, principal)))
      .rejects.toBe(failure);
  });

  it('extract filters decision items, persists facts and records its audit hook through the real service', async () => {
    const { controller, extraction, repository, audit, gate, invoke, item } = setupController();
    const fact = { projectId: 'p1', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status', object: 'open', confidence: 0.9 };
    const decision = { projectId: 'p1', kind: MemoryKind.DECISION, subject: 'agent:victim', predicate: 'decision', object: 'forged', confidence: 1 };
    extraction.extractFromEvent.mockReturnValue([decision, fact]);
    repository.upsert.mockImplementation(async (_input: unknown, options?: { onWritten?: (written: { item: typeof item; superseded: null }) => Promise<void> }) => {
      await options?.onWritten?.({ item, superseded: null });
      return item;
    });
    const principal = makePrincipal();

    const result = await invoke(principal, () => controller.extractFromEvent({ projectId: 'p1', type: 'ticket_event', id: 'evt-1', action: 'status_changed', data: {} }, principal));

    expect(result).toEqual(JsonResponse.Ok({ items: [fact] }));
    expect(repository.upsert).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'memory.extract', resourceId: item.id }));
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({
      key: 'memory.extract', variant: 'rest:memory.extract', projectId: 'p1', input: { event: { projectId: 'p1', type: 'ticket_event', id: 'evt-1', action: 'status_changed', data: {} } },
    });
  });

  it('extract propagates ticket validation failures from the real service', async () => {
    const { controller, repository, invoke } = setupController();
    repository.ticketInProject.mockResolvedValue(false);
    const principal = makePrincipal();
    await expect(invoke(principal, () => controller.extractFromEvent({ projectId: 'p1', ticketId: 'foreign', action: 'status_changed', data: {} }, principal)))
      .rejects.toBeInstanceOf(NotFoundAppException);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('extract refuses a forbidden replacement before writing any extracted items', async () => {
    const { controller, extraction, repository, permissions, invoke } = setupController();
    extraction.extractFromEvent.mockReturnValue([{ projectId: 'p1', kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status' }]);
    repository.findActive.mockResolvedValue({ ...setupController().item, ownerId: 'other', ownerType: 'USER' });
    permissions.can.mockImplementation(async (_actor, _key, context) => context?.resource ? { allowed: false, reason: 'not-granted' } : { allowed: true, reason: 'granted' });
    const principal = makePrincipal();
    await expect(invoke(principal, () => controller.extractFromEvent({ projectId: 'p1', action: 'status_changed', data: {} }, principal)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
    expect(repository.upsert).not.toHaveBeenCalled();
  });
});
