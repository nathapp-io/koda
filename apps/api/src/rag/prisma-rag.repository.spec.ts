import { PrismaRagRepository } from './prisma-rag.repository';

/** The repository over a stub client: this suite is about the query the retrieval index reads with. */
function repositoryOverTicket(): { repository: PrismaRagRepository; findFirst: ReturnType<typeof vi.fn> } {
  const findFirst = vi.fn();
  const prisma = { client: { ticket: { findFirst } } };
  return { repository: new PrismaRagRepository(prisma as never), findFirst };
}

describe('PrismaRagRepository.findTicketById', () => {
  it('B2: excludes a soft-deleted ticket, so a retried event cannot re-index it', async () => {
    const { repository, findFirst } = repositoryOverTicket();
    findFirst.mockResolvedValue({ id: 't1', title: 'Login bug' });

    await expect(repository.findTicketById('t1')).resolves.toEqual({ id: 't1', title: 'Login bug' });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 't1', deletedAt: null },
      select: { id: true, title: true },
    });
  });

  it('B2: answers null when the ticket is not there or was deleted', async () => {
    const { repository, findFirst } = repositoryOverTicket();
    findFirst.mockResolvedValue(null);

    await expect(repository.findTicketById('t1')).resolves.toBeNull();
  });
});
