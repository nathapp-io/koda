import { Test, TestingModule } from '@nestjs/testing';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';

describe('TicketLinksController', () => {
  let controller: TicketLinksController;
  let service: TicketLinksService;

  const mockLink = {
    id: 'link-123',
    ticketId: 'ticket-123',
    url: 'https://github.com/owner/repo/pull/1',
    provider: 'github',
    externalRef: 'owner/repo#1',
    createdAt: new Date(),
  };

  const mockTicketLinksService = {
    create: jest.fn(),
    findByTicket: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketLinksController],
      providers: [
        { provide: TicketLinksService, useValue: mockTicketLinksService },
      ],
    }).compile();

    controller = module.get<TicketLinksController>(TicketLinksController);
    service = module.get<TicketLinksService>(TicketLinksService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /projects/:slug/tickets/:ref/links', () => {
    it('calls service.create and returns the new link wrapped in JsonResponse with status 201', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinksService.create.mockResolvedValue({
        status: 201,
        link: mockLink,
      });

      const result = await controller.create('koda', 'KODA-1', dto);

      expect(service.create).toHaveBeenCalledWith('koda', 'KODA-1', dto);
      expect(result).toBeDefined();
    });

    it('calls service.create and returns existing link when deduplication triggers status 200', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinksService.create.mockResolvedValue({
        status: 200,
        link: mockLink,
      });

      const result = await controller.create('koda', 'KODA-1', dto);

      expect(service.create).toHaveBeenCalledWith('koda', 'KODA-1', dto);
      expect(result).toBeDefined();
    });

    it('propagates NotFoundException from service when ticket not found', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinksService.create.mockRejectedValue(
        new Error('Ticket not found'),
      );

      await expect(
        controller.create('koda', 'KODA-999', dto),
      ).rejects.toThrow();
    });
  });

  describe('GET /projects/:slug/tickets/:ref/links', () => {
    it('calls service.findByTicket and returns links array wrapped in JsonResponse', async () => {
      const secondLink = {
        ...mockLink,
        id: 'link-456',
        url: 'https://gitlab.com/owner/repo/-/merge_requests/7',
        provider: 'gitlab',
        externalRef: 'owner/repo#7',
      };

      mockTicketLinksService.findByTicket.mockResolvedValue([
        mockLink,
        secondLink,
      ]);

      const result = await controller.findAll('koda', 'KODA-1');

      expect(service.findByTicket).toHaveBeenCalledWith('koda', 'KODA-1');
      expect(result).toBeDefined();
    });

    it('calls service.findByTicket and returns empty array when no links', async () => {
      mockTicketLinksService.findByTicket.mockResolvedValue([]);

      const result = await controller.findAll('koda', 'KODA-1');

      expect(service.findByTicket).toHaveBeenCalledWith('koda', 'KODA-1');
      expect(result).toBeDefined();
    });

    it('propagates NotFoundException from service when ticket not found', async () => {
      mockTicketLinksService.findByTicket.mockRejectedValue(
        new Error('Ticket not found'),
      );

      await expect(
        controller.findAll('koda', 'KODA-999'),
      ).rejects.toThrow();
    });
  });

  describe('DELETE /projects/:slug/tickets/:ref/links/:linkId', () => {
    it('calls service.remove with correct params', async () => {
      mockTicketLinksService.remove.mockResolvedValue(undefined);

      await controller.remove('koda', 'KODA-1', 'link-123');

      expect(service.remove).toHaveBeenCalledWith('koda', 'KODA-1', 'link-123');
    });

    it('propagates NotFoundException from service when linkId not found on ticket', async () => {
      mockTicketLinksService.remove.mockRejectedValue(
        new Error('Link not found'),
      );

      await expect(
        controller.remove('koda', 'KODA-1', 'nonexistent-link'),
      ).rejects.toThrow();
    });

    it('returns void (no body) on successful deletion', async () => {
      mockTicketLinksService.remove.mockResolvedValue(undefined);

      const result = await controller.remove('koda', 'KODA-1', 'link-123');

      expect(result).toBeUndefined();
    });
  });
});
