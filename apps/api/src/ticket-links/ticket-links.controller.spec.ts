import { Test, TestingModule } from '@nestjs/testing';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { REQUIRES_METADATA, RequiresMetadata } from '../permissions/requires.decorator';
import type { AgentPrincipal, KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

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

const makeAgentPrincipal = (): AgentPrincipal => ({
  actorType: 'agent',
  id: 'agent-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  slug: 'agent-one',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
});

describe('TicketLinksController route permission metadata (US-006)', () => {
  /** Every route on this controller declares its catalog key with @Requires. */
  const requiresCases: Array<[keyof TicketLinksController, string[], 'guard' | 'service']> = [
    ['create', ['ticket.link.add'], 'guard'],
    ['findAll', ['ticket.link.read'], 'guard'],
    ['remove', ['ticket.link.remove'], 'service'],
  ];

  it.each(requiresCases)('%s declares @Requires(%j, enforcedBy %s)', (handler, keys, enforcedBy) => {
    const fn = TicketLinksController.prototype[handler] as unknown as object;
    const metadata = Reflect.getMetadata(REQUIRES_METADATA, fn) as RequiresMetadata;

    expect(metadata).toEqual({ keys, mode: 'all', enforcedBy });
    // The legacy decorators are gone from the migrated routes, so only one mechanism decides them.
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });

  it.each(requiresCases)('%s runs ProjectMembershipGuard before RequiresGuard', (handler) => {
    const fn = TicketLinksController.prototype[handler] as unknown as object;
    const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];

    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });
});

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
    create: vi.fn(),
    findByTicket: vi.fn(),
    remove: vi.fn(),
  };

  const principal: KodaPrincipal = makeUserPrincipal();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketLinksController],
      providers: [
        { provide: TicketLinksService, useValue: mockTicketLinksService },
        // ProjectMembershipGuard is instantiated by the DI container even though these tests call
        // the handlers directly, so its ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
        // RequiresGuard is instantiated the same way and needs the global PermissionService.
        { provide: PermissionService, useValue: { can: vi.fn() } },
      ],
    }).compile();

    controller = module.get<TicketLinksController>(TicketLinksController);
    service = module.get<TicketLinksService>(TicketLinksService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /projects/:slug/tickets/:ref/links', () => {
    it('passes the caller to service.create as a USER principal ref with status 201', async () => {
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      mockTicketLinksService.create.mockResolvedValue({ status: 201, link: mockLink });

      const result = await controller.create('koda', 'KODA-1', dto, principal);

      expect(service.create).toHaveBeenCalledWith('koda', 'KODA-1', dto, { type: 'USER', id: 'user-1' });
      expect(result).toBeDefined();
    });

    it('converts an agent caller into an AGENT principal ref, keeping its id', async () => {
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      mockTicketLinksService.create.mockResolvedValue({ status: 201, link: mockLink });

      await controller.create('koda', 'KODA-1', dto, makeAgentPrincipal());

      expect(service.create).toHaveBeenCalledWith('koda', 'KODA-1', dto, { type: 'AGENT', id: 'agent-1' });
    });

    it('sets the reply status to 200 when the link already existed (deduplication)', async () => {
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      mockTicketLinksService.create.mockResolvedValue({ status: 200, link: mockLink });
      const res = { statusCode: 201 };

      await controller.create('koda', 'KODA-1', dto, principal, res);

      expect(res.statusCode).toBe(200);
    });

    it('leaves the reply status untouched for a new link', async () => {
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      mockTicketLinksService.create.mockResolvedValue({ status: 201, link: mockLink });
      const res = { statusCode: 201 };

      await controller.create('koda', 'KODA-1', dto, principal, res);

      expect(res.statusCode).toBe(201);
    });

    it('propagates NotFoundException from service when ticket not found', async () => {
      const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };
      mockTicketLinksService.create.mockRejectedValue(new Error('Ticket not found'));

      await expect(controller.create('koda', 'KODA-999', dto, principal)).rejects.toThrow();
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

      mockTicketLinksService.findByTicket.mockResolvedValue([mockLink, secondLink]);

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
      mockTicketLinksService.findByTicket.mockRejectedValue(new Error('Ticket not found'));

      await expect(controller.findAll('koda', 'KODA-999')).rejects.toThrow();
    });
  });

  describe('DELETE /projects/:slug/tickets/:ref/links/:linkId', () => {
    it('passes the full principal to service.remove with the correct params', async () => {
      mockTicketLinksService.remove.mockResolvedValue(undefined);

      await controller.remove('koda', 'KODA-1', 'link-123', principal);

      expect(service.remove).toHaveBeenCalledWith('koda', 'KODA-1', 'link-123', principal);
    });

    it('passes an agent principal through unchanged', async () => {
      mockTicketLinksService.remove.mockResolvedValue(undefined);
      const agent = makeAgentPrincipal();

      await controller.remove('koda', 'KODA-1', 'link-123', agent);

      expect(service.remove).toHaveBeenCalledWith('koda', 'KODA-1', 'link-123', agent);
    });

    it('propagates NotFoundException from service when linkId not found on ticket', async () => {
      mockTicketLinksService.remove.mockRejectedValue(new Error('Link not found'));

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
