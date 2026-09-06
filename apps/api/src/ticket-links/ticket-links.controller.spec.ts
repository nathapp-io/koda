import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import type { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

const makeUserPrincipal = (): UserPrincipal => ({
  actorType: 'user',
  id: 'user-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  role: 'MEMBER',
  email: 'test@example.com',
});

describe('TicketLinksController', () => {
  let controller: TicketLinksController;
  let service: TicketLinksService;
  let projectsService: jest.Mocked<Partial<ProjectsService>>;

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

  const principal: KodaPrincipal = makeUserPrincipal();

  beforeEach(async () => {
    projectsService = {
      findProjectIdBySlug: jest.fn().mockResolvedValue('project-1'),
      assertProjectMembership: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketLinksController],
      providers: [
        { provide: TicketLinksService, useValue: mockTicketLinksService },
        { provide: ProjectsService, useValue: projectsService },
      ],
    }).compile();

    controller = module.get<TicketLinksController>(TicketLinksController);
    service = module.get<TicketLinksService>(TicketLinksService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('membership check', () => {
    it('rejects POST when caller is not a project member', async () => {
      (projectsService.assertProjectMembership as jest.Mock).mockRejectedValue(new ForbiddenAppException({}, 'projects'));
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      await expect(controller.create('koda', 'KODA-1', dto, principal)).rejects.toThrow(ForbiddenAppException);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects GET when caller is not a project member', async () => {
      (projectsService.assertProjectMembership as jest.Mock).mockRejectedValue(new ForbiddenAppException({}, 'projects'));
      await expect(controller.findAll('koda', 'KODA-1', principal)).rejects.toThrow(ForbiddenAppException);
      expect(service.findByTicket).not.toHaveBeenCalled();
    });

    it('rejects DELETE when caller is not a project member', async () => {
      (projectsService.assertProjectMembership as jest.Mock).mockRejectedValue(new ForbiddenAppException({}, 'projects'));
      await expect(controller.remove('koda', 'KODA-1', 'link-123', principal)).rejects.toThrow(ForbiddenAppException);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('rejects all routes when the project slug is not found', async () => {
      (projectsService.findProjectIdBySlug as jest.Mock).mockRejectedValue(new NotFoundAppException({}, 'projects'));
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      await expect(controller.create('missing', 'KODA-1', dto, principal)).rejects.toThrow(NotFoundAppException);
      await expect(controller.findAll('missing', 'KODA-1', principal)).rejects.toThrow(NotFoundAppException);
      await expect(controller.remove('missing', 'KODA-1', 'link-123', principal)).rejects.toThrow(NotFoundAppException);
    });
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

      const result = await controller.create('koda', 'KODA-1', dto, principal);

      expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', principal);
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

      const result = await controller.create('koda', 'KODA-1', dto, principal);

      expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', principal);
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
        controller.create('koda', 'KODA-999', dto, principal),
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

      const result = await controller.findAll('koda', 'KODA-1', principal);

      expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', principal);
      expect(service.findByTicket).toHaveBeenCalledWith('koda', 'KODA-1');
      expect(result).toBeDefined();
    });

    it('calls service.findByTicket and returns empty array when no links', async () => {
      mockTicketLinksService.findByTicket.mockResolvedValue([]);

      const result = await controller.findAll('koda', 'KODA-1', principal);

      expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', principal);
      expect(service.findByTicket).toHaveBeenCalledWith('koda', 'KODA-1');
      expect(result).toBeDefined();
    });

    it('propagates NotFoundException from service when ticket not found', async () => {
      mockTicketLinksService.findByTicket.mockRejectedValue(
        new Error('Ticket not found'),
      );

      await expect(
        controller.findAll('koda', 'KODA-999', principal),
      ).rejects.toThrow();
    });
  });

  describe('DELETE /projects/:slug/tickets/:ref/links/:linkId', () => {
    it('calls service.remove with correct params', async () => {
      mockTicketLinksService.remove.mockResolvedValue(undefined);

      await controller.remove('koda', 'KODA-1', 'link-123', principal);

      expect(projectsService.assertProjectMembership).toHaveBeenCalledWith('project-1', principal);
      expect(service.remove).toHaveBeenCalledWith('koda', 'KODA-1', 'link-123');
    });

    it('propagates NotFoundException from service when linkId not found on ticket', async () => {
      mockTicketLinksService.remove.mockRejectedValue(
        new Error('Link not found'),
      );

      await expect(
        controller.remove('koda', 'KODA-1', 'nonexistent-link', principal),
      ).rejects.toThrow();
    });

    it('returns void (no body) on successful deletion', async () => {
      mockTicketLinksService.remove.mockResolvedValue(undefined);

      const result = await controller.remove('koda', 'KODA-1', 'link-123', principal);

      expect(result).toBeUndefined();
    });
  });
});
