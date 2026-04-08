import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';

describe('TicketLinksService', () => {
  let service: TicketLinksService;

  const mockProject = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: null,
    status: 'CREATED',
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: 'user-123',
    createdByAgentId: null,
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    gitRefUrl: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockLink = {
    id: 'link-123',
    ticketId: 'ticket-123',
    url: 'https://github.com/owner/repo/pull/1',
    provider: 'github',
    externalRef: 'owner/repo#1',
    prState: null,
    prNumber: null,
    prUpdatedAt: null,
    linkType: 'url',
    createdAt: new Date(),
  };

  const mockPrismaService = {
    client: {
      project: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      ticket: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      ticketLink: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
    },
  };

  beforeEach(() => {
    service = new TicketLinksService(mockPrismaService as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a new link for a GitHub PR URL and returns status 201', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(result.status).toBe(201);
      expect(result.link.provider).toBe('github');
      expect(result.link.externalRef).toBe('owner/repo#1');
      expect(result.link.url).toBe(dto.url);
    });

    it('returns status 201 and sets provider and externalRef via detectProvider', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(mockPrismaService.client.ticketLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            url: dto.url,
            provider: 'github',
            externalRef: 'owner/repo#1',
            ticketId: mockTicket.id,
          }),
        }),
      );
      expect(result.status).toBe(201);
    });

    it('returns existing link with status 200 when URL is already linked (deduplication)', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(result.status).toBe(200);
      expect(result.link).toEqual({
        ...mockLink,
        title: null,
      });
      expect(mockPrismaService.client.ticketLink.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);

      await expect(service.create('koda', 'KODA-999', dto)).rejects.toThrow();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(null);

      await expect(
        service.create('nonexistent', 'KODA-1', dto),
      ).rejects.toThrow();
    });

    it('auto-populates provider as "other" and externalRef as null for unknown URL format', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://example.com/some/page',
      };

      const unknownLink = {
        ...mockLink,
        url: dto.url,
        provider: 'other',
        externalRef: null,
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticketLink.create.mockResolvedValue(unknownLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(mockPrismaService.client.ticketLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            provider: 'other',
            externalRef: null,
          }),
        }),
      );
      expect(result.status).toBe(201);
    });
  });

  describe('findByTicket', () => {
    it('returns an array of links for a ticket with two links', async () => {
      const secondLink = {
        ...mockLink,
        id: 'link-456',
        url: 'https://gitlab.com/owner/repo/-/merge_requests/7',
        provider: 'gitlab',
        externalRef: 'owner/repo#7',
      };

      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findMany.mockResolvedValue([
        mockLink,
        secondLink,
      ]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        ...mockLink,
        title: null,
      });
      expect(result[1]).toEqual({
        ...secondLink,
        title: null,
      });
    });

    it('returns an empty array when ticket has no links', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findMany.mockResolvedValue([]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toEqual([]);
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.findByTicket('koda', 'KODA-999'),
      ).rejects.toThrow();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(null);

      await expect(
        service.findByTicket('nonexistent', 'KODA-1'),
      ).rejects.toThrow();
    });

    it('queries links scoped to the resolved ticket', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findMany.mockResolvedValue([mockLink]);

      await service.findByTicket('koda', 'KODA-1');

      expect(mockPrismaService.client.ticketLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ticketId: mockTicket.id }),
        }),
      );
    });
  });

  describe('remove', () => {
    it('deletes a link by id when it belongs to the ticket', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(mockLink);
      mockPrismaService.client.ticketLink.delete.mockResolvedValue(mockLink);

      await service.remove('koda', 'KODA-1', 'link-123');

      expect(mockPrismaService.client.ticketLink.delete).toHaveBeenCalledWith({
        where: { id: 'link-123' },
      });
    });

    it('throws NotFoundException when linkId does not exist on that ticket', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-1', 'nonexistent-link'),
      ).rejects.toThrow();
    });

    it('does not delete when link belongs to a different ticket', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(mockTicket);
      // findFirst scoped to ticketId returns null (link exists but for another ticket)
      mockPrismaService.client.ticketLink.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-1', 'link-other-ticket'),
      ).rejects.toThrow();

      expect(mockPrismaService.client.ticketLink.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('nonexistent', 'KODA-1', 'link-123'),
      ).rejects.toThrow();
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      mockPrismaService.client.project.findFirst.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-999', 'link-123'),
      ).rejects.toThrow();
    });
  });
});
