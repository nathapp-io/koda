import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { MemoryWriteService } from './memory-write.service';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { MemoryWriteGuard } from './memory-write.guard';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { MemoryItem } from './memory-item-repository';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

const principal = { actorType: 'user', id: 'u1' } as KodaPrincipal;
function setup() {
  const item: MemoryItem = { id: 'm1', projectId: 'p1', scope: 'project', kind: 'DECISION', status: 'active', subject: 's', predicate: 'p', confidence: 1, createdAt: new Date(), updatedAt: new Date() };
  const repository = {
    findById: vi.fn().mockResolvedValue(item),
    retire: vi.fn(async (_id: string, check: (target: MemoryItem | null) => Promise<void>, onRetired: (target: MemoryItem) => Promise<void>) => {
      await check(item);
      await onRetired(item);
      return item;
    }),
  };
  const access = { assertProjectMembership: vi.fn().mockResolvedValue(undefined) };
  const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
  const guard = { mayReplace: vi.fn().mockResolvedValue(true) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new MemoryWriteService({} as ExtractionService, repository as unknown as PrismaMemoryItemRepository, access as unknown as ProjectAccessService, permissions as unknown as PermissionService, guard as unknown as MemoryWriteGuard, audit as unknown as AuditRecorder);
  return { item, repository, access, permissions, guard, audit, service };
}

describe('retirement execution checks', () => {
  it.each([
    ['kind', 'FACT', 'memory.retireNotDecision'],
    ['status', 'superseded', 'memory.retireNotActive'],
  ] as const)('rechecks %s after preflight', async (field, value, prefix) => {
    const h = setup();
    await expect(h.service.retireTarget(principal, 'm1')).resolves.toEqual({ projectId: 'p1' });
    h.item[field] = value;
    await expect(h.service.retireDecision(principal, 'm1')).rejects.toMatchObject({ prefix });
    expect(h.audit.record).not.toHaveBeenCalled();
  });
  it('rechecks membership and hides only a refusal at execution', async () => {
    const h = setup();
    await h.service.retireTarget(principal, 'm1');
    h.access.assertProjectMembership.mockRejectedValueOnce(new ForbiddenAppException({}, 'projects'));
    await expect(h.service.retireDecision(principal, 'm1')).rejects.toMatchObject({ prefix: 'memory.notFound' });
    const failure = new Error('database unavailable');
    h.access.assertProjectMembership.mockRejectedValueOnce(failure);
    await expect(h.service.retireDecision(principal, 'm1')).rejects.toBe(failure);
    expect(h.audit.record).not.toHaveBeenCalled();
  });
  it('rechecks the key and ownership inside the write', async () => {
    const h = setup();
    h.permissions.can.mockResolvedValueOnce({ allowed: false });
    await expect(h.service.retireDecision(principal, 'm1')).rejects.toMatchObject({ prefix: 'permissions' });
    expect(h.permissions.can).toHaveBeenCalledWith(principal, 'memory.decision.retire', { projectId: 'p1' });
    h.guard.mayReplace.mockResolvedValueOnce(false);
    await expect(h.service.retireDecision(principal, 'm1')).rejects.toMatchObject({ prefix: 'permissions' });
    expect(h.guard.mayReplace).toHaveBeenCalledWith(principal, 'p1', h.item);
    expect(h.audit.record).not.toHaveBeenCalled();
  });
});

/**
 * US-011 fix round 1: the note retire route declares `memory.create` and `memory.update` as service-enforced, so
 * the write itself enforces both. `memory.create` used to be answered only by the route gate's key check, which
 * left a caller holding the replace authority (`memory.update`) but not `memory.create` able to reach the write
 * — and left a deferred execution, which runs later as the requester, with no check of its own.
 */
describe('note retirement authorization', () => {
  const projectNote = (over: Partial<MemoryItem> = {}): MemoryItem => ({
    id: 'n1', projectId: 'p1', scope: 'project', kind: 'NOTE', status: 'active',
    subject: 'replay-budget', predicate: 'project', ownerType: 'AGENT', ownerId: 'a1',
    confidence: 1, createdAt: new Date(), updatedAt: new Date(), ...over,
  });

  function setupNote(item: MemoryItem = projectNote()) {
    const repository = {
      findById: vi.fn().mockResolvedValue(item),
      retire: vi.fn(async (_id: string, check: (target: MemoryItem | null) => Promise<void>, onRetired: (target: MemoryItem) => Promise<void>) => {
        await check(item);
        await onRetired(item);
        return item;
      }),
    };
    const access = { assertProjectMembership: vi.fn().mockResolvedValue(undefined) };
    const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
    const guard = { mayReplace: vi.fn().mockResolvedValue(true) };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new MemoryWriteService(
      {} as ExtractionService, repository as unknown as PrismaMemoryItemRepository,
      access as unknown as ProjectAccessService, permissions as unknown as PermissionService,
      guard as unknown as MemoryWriteGuard, audit as unknown as AuditRecorder,
    );
    return { repository, access, permissions, guard, audit, service };
  }

  it('refuses the retirement when the caller may replace but does not hold memory.create', async () => {
    const h = setupNote();
    // The replace authority is granted (`mayReplace` answers true); `memory.create` in the project is not.
    h.permissions.can.mockImplementation(async (_actor: unknown, key: string) =>
      key === 'memory.create' ? { allowed: false, reason: 'not-granted' } : { allowed: true, reason: 'granted' });

    await expect(h.service.retireNote(principal, 'n1')).rejects.toMatchObject({ prefix: 'permissions' });

    expect(h.permissions.can).toHaveBeenCalledWith(principal, 'memory.create', { projectId: 'p1' });
    expect(h.guard.mayReplace).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('enforces memory.create in the note\'s own project, ignoring a body projectId', async () => {
    const h = setupNote();

    await expect(h.service.retireNote(principal, 'n1', 'p-other')).resolves.toMatchObject({ id: 'n1' });

    expect(h.permissions.can).toHaveBeenCalledWith(principal, 'memory.create', { projectId: 'p1' });
    expect(h.permissions.can).not.toHaveBeenCalledWith(principal, 'memory.create', { projectId: 'p-other' });
  });

  it("enforces memory.create in the project a user note's body names", async () => {
    const h = setupNote(projectNote({
      projectId: null, scope: 'user', ownerKey: `USER:${principal.id}`, ownerType: 'USER', ownerId: principal.id,
    }));

    await expect(h.service.retireNote(principal, 'n1', 'p2')).resolves.toMatchObject({ id: 'n1' });

    expect(h.permissions.can).toHaveBeenCalledWith(principal, 'memory.create', { projectId: 'p2' });
    // A user note is the caller's own, so there is no other principal's row to ask the replace check about.
    expect(h.guard.mayReplace).not.toHaveBeenCalled();
  });
});
