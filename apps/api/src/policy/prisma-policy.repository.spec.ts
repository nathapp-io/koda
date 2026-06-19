import { PrismaPolicyRepository } from './prisma-policy.repository';

describe('PrismaPolicyRepository', () => {
  const mockFindUnique = jest.fn();
  const mockPrisma = {
    client: {
      ticket: {
        findUnique: mockFindUnique,
      },
    },
  };

  let repo: PrismaPolicyRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaPolicyRepository(mockPrisma as never);
  });

  describe('findTicketById', () => {
    it('returns a TicketSnapshot when the ticket exists', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'ticket-1',
        status: 'open',
        priority: 'high',
        title: 'Fix the bug',
      });

      const result = await repo.findTicketById('ticket-1');

      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        select: { id: true, status: true, priority: true, title: true },
      });
      expect(result).toEqual({
        id: 'ticket-1',
        status: 'open',
        priority: 'high',
        title: 'Fix the bug',
      });
    });

    it('returns null when the ticket does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await repo.findTicketById('nonexistent');

      expect(result).toBeNull();
    });

    it('maps all four fields from the Prisma row', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'ticket-abc',
        status: 'closed',
        priority: 'low',
        title: 'Old task',
      });

      const result = await repo.findTicketById('ticket-abc');

      expect(result).toMatchObject({
        id: 'ticket-abc',
        status: 'closed',
        priority: 'low',
        title: 'Old task',
      });
    });

    it('propagates Prisma errors', async () => {
      mockFindUnique.mockRejectedValue(new Error('db connection failed'));

      await expect(repo.findTicketById('ticket-1')).rejects.toThrow('db connection failed');
    });
  });
});
