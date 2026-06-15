import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkDomain } from './domain/ticket-link.domain';

describe('TicketLinksService', () => {
  let service: TicketLinksService;

  const mockLink: TicketLinkDomain = {
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

  const mockTicketLinkRepo = {
    findProjectBySlug: jest.fn(),
    findTicketByNumber: jest.fn(),
    findTicketById: jest.fn(),
    findLinkByUrl: jest.fn(),
    createLink: jest.fn(),
    findLinksByTicket: jest.fn(),
    updateLink: jest.fn(),
    findLinkByIdAndTicket: jest.fn(),
    deleteLink: jest.fn(),
    findByPrNumber: jest.fn(),
  };

  beforeEach(() => {
    service = new TicketLinksService(mockTicketLinkRepo as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a new link for a GitHub PR URL and returns status 201', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(null);
      mockTicketLinkRepo.createLink.mockResolvedValue(mockLink);

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

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(null);
      mockTicketLinkRepo.createLink.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(mockTicketLinkRepo.createLink).toHaveBeenCalledWith(
        expect.objectContaining({
          url: dto.url,
          provider: 'github',
          externalRef: 'owner/repo#1',
          ticketId: 'ticket-123',
        }),
      );
      expect(result.status).toBe(201);
    });

    it('returns existing link with status 200 when URL is already linked (deduplication)', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(result.status).toBe(200);
      expect(result.link).toEqual({
        ...mockLink,
        title: null,
      });
      expect(mockTicketLinkRepo.createLink).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue(null);

      await expect(service.create('koda', 'KODA-999', dto)).rejects.toThrow();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.create('nonexistent', 'KODA-1', dto),
      ).rejects.toThrow();
    });

    it('auto-populates provider as "other" and externalRef as null for unknown URL format', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://example.com/some/page',
      };

      const unknownLink: TicketLinkDomain = {
        ...mockLink,
        url: dto.url,
        provider: 'other',
        externalRef: null,
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(null);
      mockTicketLinkRepo.createLink.mockResolvedValue(unknownLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(mockTicketLinkRepo.createLink).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'other',
          externalRef: null,
        }),
      );
      expect(result.status).toBe(201);
    });
  });

  describe('findByTicket', () => {
    it('returns an array of links for a ticket with two links', async () => {
      const secondLink: TicketLinkDomain = {
        ...mockLink,
        id: 'link-456',
        url: 'https://gitlab.com/owner/repo/-/merge_requests/7',
        provider: 'gitlab',
        externalRef: 'owner/repo#7',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinksByTicket.mockResolvedValue([mockLink, secondLink]);

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
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinksByTicket.mockResolvedValue([]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toEqual([]);
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue(null);

      await expect(
        service.findByTicket('koda', 'KODA-999'),
      ).rejects.toThrow();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.findByTicket('nonexistent', 'KODA-1'),
      ).rejects.toThrow();
    });

    it('queries links scoped to the resolved ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinksByTicket.mockResolvedValue([mockLink]);

      await service.findByTicket('koda', 'KODA-1');

      expect(mockTicketLinkRepo.findLinksByTicket).toHaveBeenCalledWith('ticket-123');
    });
  });

  describe('remove', () => {
    it('deletes a link by id when it belongs to the ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(mockLink);
      mockTicketLinkRepo.deleteLink.mockResolvedValue(undefined);

      await service.remove('koda', 'KODA-1', 'link-123');

      expect(mockTicketLinkRepo.deleteLink).toHaveBeenCalledWith('link-123');
    });

    it('throws NotFoundException when linkId does not exist on that ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-1', 'nonexistent-link'),
      ).rejects.toThrow();
    });

    it('does not delete when link belongs to a different ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      // findLinkByIdAndTicket scoped to ticketId returns null (link exists but for another ticket)
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-1', 'link-other-ticket'),
      ).rejects.toThrow();

      expect(mockTicketLinkRepo.deleteLink).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.remove('nonexistent', 'KODA-1', 'link-123'),
      ).rejects.toThrow();
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-999', 'link-123'),
      ).rejects.toThrow();
    });
  });
});
