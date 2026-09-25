import { PrismaTicketsRepository } from './prisma-tickets.repository';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';

describe('PrismaTicketsRepository — updateTicketStatusIf (M3 hardening)', () => {
  it('keys the conditional update on id + status + deletedAt: null so soft-deleted tickets cannot be transitioned', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockResolvedValue(null);
    const repo = new PrismaTicketsRepository({
      client: { ticket: { updateMany, findUnique } },
    } as unknown as PrismaService<PrismaClient>);

    await repo.updateTicketStatusIf('ticket-123', 'CREATED', 'VERIFIED');

    expect(updateMany).toHaveBeenCalledTimes(1);
    const whereArg = updateMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({ id: 'ticket-123', status: 'CREATED', deletedAt: null });
  });
});
