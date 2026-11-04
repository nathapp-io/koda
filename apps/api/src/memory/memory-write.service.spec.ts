import { MemoryWriteService } from './memory-write.service';
import { MemoryKind } from '../common/enums';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';

describe('MemoryWriteService', () => {
  it('AC-1 rejects DECISION items on create without writing', async () => {
    const repository = { upsert: vi.fn() };
    const permissions = { can: vi.fn(async () => ({ allowed: true })) };
    const service = new MemoryWriteService(
      {} as never, repository as never, { assertProjectMembership: vi.fn() } as never,
      permissions as never, {} as never, {} as never,
    );
    const principal = { actorType: 'user', id: 'user-1' } as never;
    await expect(service.create(principal, { projectId: 'p1', kind: MemoryKind.DECISION } as never))
      .rejects.toMatchObject({ response: { prefix: 'memory' } });
    await expect(service.create(principal, { projectId: 'p1', kind: MemoryKind.DECISION } as never))
      .rejects.toBeInstanceOf(ValidationAppException);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('AC-11 (US-001) rejects a NOTE without a description, naming description, without writing', async () => {
    const repository = { upsert: vi.fn() };
    const permissions = { can: vi.fn(async () => ({ allowed: true })) };
    const service = new MemoryWriteService(
      {} as never, repository as never, { assertProjectMembership: vi.fn() } as never,
      permissions as never, {} as never, {} as never,
    );
    const principal = { actorType: 'user', id: 'user-1' } as never;
    const note = {
      projectId: 'p1', kind: MemoryKind.NOTE, subject: 'replay-budget', predicate: 'project',
      object: 'Budget stays 2,048 MiB.',
    } as never;

    const error = await service.create(principal, note).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(ValidationAppException);
    // The details name the field, and the message is translated in the memory domain (`memory.-2`).
    expect((error as ValidationAppException).args).toEqual({ field: 'description' });
    expect((error as ValidationAppException).prefix).toBe('memory');
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  // US-011 AC-10: `RetireNoteDto.projectId` is `@IsOptional()`, which lets an explicit `null` through
  // validation exactly as an absent field, so a null body has to mean "no project named" — never a TypeError.
  describe('retireNoteTarget with a null body projectId (US-011 AC-10)', () => {
    const principal = { actorType: 'user', id: 'user-1' } as never;
    /** The row under test, as the repository answers it. */
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'mem-1',
      projectId: 'p1',
      kind: MemoryKind.NOTE,
      scope: 'project',
      ownerKey: undefined,
      status: 'active',
      ...over,
    });

    const serviceFor = (item: Record<string, unknown>) => {
      const projectAccess = { assertProjectMembership: vi.fn(async () => undefined) };
      const service = new MemoryWriteService(
        {} as never, { findById: vi.fn(async () => item) } as never, projectAccess as never,
        {} as never, {} as never, {} as never,
      );
      return { service, projectAccess };
    };

    it('reads null as no projectId, so a project note still retires in its own project', async () => {
      const { service, projectAccess } = serviceFor(row());

      await expect(service.retireNoteTarget(principal, 'mem-1', null)).resolves.toEqual({ projectId: 'p1' });
      expect(projectAccess.assertProjectMembership).toHaveBeenCalledWith('p1', principal);
    });

    it("answers the caller's own user note as a missing projectId, not as a failure", async () => {
      const { service } = serviceFor(row({ scope: 'user', projectId: null, ownerKey: 'USER:user-1' }));

      const error = await service.retireNoteTarget(principal, 'mem-1', null).catch((rejection: unknown) => rejection);

      expect(error).toBeInstanceOf(ValidationAppException);
      expect((error as ValidationAppException).args).toEqual({ field: 'projectId' });
      expect((error as ValidationAppException).prefix).toBe('memory');
    });

    it("answers another principal's user note as not found before reading the body", async () => {
      const { service, projectAccess } = serviceFor(row({ scope: 'user', projectId: null, ownerKey: 'USER:other' }));

      const error = await service.retireNoteTarget(principal, 'mem-1', null).catch((rejection: unknown) => rejection);

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect((error as NotFoundAppException).prefix).toBe('memory.notFound');
      // Ownership refuses it first: the body is never interpreted for a row the caller may not see.
      expect(projectAccess.assertProjectMembership).not.toHaveBeenCalled();
    });
  });
});
