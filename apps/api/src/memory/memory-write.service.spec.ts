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
});
