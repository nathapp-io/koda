import { MemoryWriteService } from './memory-write.service';
import { MemoryKind } from '../common/enums';
import { ValidationAppException } from '@nathapp/nestjs-common';

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
});
