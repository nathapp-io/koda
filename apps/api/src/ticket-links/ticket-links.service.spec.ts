import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { TicketLinksService } from './ticket-links.service';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkDomain } from './domain/ticket-link.domain';
import type { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import type { PermissionService } from '../permissions/permission.service';

const userPrincipal: UserPrincipal = {
  actorType: 'user',
  id: 'user-1',
  name: undefined,
  role: 'MEMBER',
  email: 'dev@example.com',
  blacklisted: false,
  revoked: false,
  authorities: [],
};

describe('TicketLinksService', () => {
  let service: TicketLinksService;

  const mockPermissions = { can: vi.fn() };

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
    source: 'vcs',
    jobId: null,
    createdByUserId: null,
    createdByAgentId: null,
    createdAt: new Date(),
  };

  const mockTicketLinkRepo = {
    findProjectBySlug: vi.fn(),
    findTicketByNumber: vi.fn(),
    findTicketById: vi.fn(),
    findLinkByUrl: vi.fn(),
    createLink: vi.fn(),
    findLinksByTicket: vi.fn(),
    findLinkByIdAndTicket: vi.fn(),
    deleteLink: vi.fn(),
    findByPrNumber: vi.fn(),
  };

  beforeEach(() => {
    service = new TicketLinksService(
      mockTicketLinkRepo as unknown as ConstructorParameters<typeof TicketLinksService>[0],
      mockPermissions as unknown as PermissionService,
    );
    mockPermissions.can.mockResolvedValue({ allowed: true, reason: 'granted' });
  });

  /**
   * The response DTO shape, unchanged by US-006: `createdByUserId` / `createdByAgentId` are internal
   * and must not appear in the API response.
   */
  const expectLinkDto = (actual: unknown, link: TicketLinkDomain, title: string | null = null): void => {
    expect(actual).toEqual({
      id: link.id,
      ticketId: link.ticketId,
      url: link.url,
      provider: link.provider,
      externalRef: link.externalRef,
      prState: link.prState,
      prNumber: link.prNumber,
      prUpdatedAt: link.prUpdatedAt,
      linkType: link.linkType,
      source: link.source,
      jobId: link.jobId,
      title,
      createdAt: link.createdAt,
    });
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('creates a new link for a GitHub PR URL and returns status 201', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
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

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
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

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'KODA-1', dto);

      expect(result.status).toBe(200);
      expectLinkDto(result.link, mockLink);
      expect(mockTicketLinkRepo.createLink).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      const dto: CreateTicketLinkDto = {
        url: 'https://github.com/owner/repo/pull/1',
      };

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
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

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
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

      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinksByTicket.mockResolvedValue([mockLink, secondLink]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toHaveLength(2);
      expectLinkDto(result[0], mockLink);
      expectLinkDto(result[1], secondLink);
    });

    it('returns an empty array when ticket has no links', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinksByTicket.mockResolvedValue([]);

      const result = await service.findByTicket('koda', 'KODA-1');

      expect(result).toEqual([]);
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
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
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinksByTicket.mockResolvedValue([mockLink]);

      await service.findByTicket('koda', 'KODA-1');

      expect(mockTicketLinkRepo.findLinksByTicket).toHaveBeenCalledWith('ticket-123');
    });
  });

  // US-006: the optional creator is written when the caller is known and left null when it is not
  // (the assistant link tool calls `create` without one).
  describe('creator recording', () => {
    const dto: CreateTicketLinkDto = { url: 'https://github.com/owner/repo/pull/1' };

    beforeEach(() => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(null);
      mockTicketLinkRepo.createLink.mockResolvedValue(mockLink);
    });

    it('records a USER creator as createdByUserId', async () => {
      await service.create('koda', 'KODA-1', dto, { type: 'USER', id: 'user-1' });

      expect(mockTicketLinkRepo.createLink).toHaveBeenCalledWith(
        expect.objectContaining({ createdByUserId: 'user-1', createdByAgentId: null }),
      );
    });

    it('records an AGENT creator as createdByAgentId', async () => {
      await service.create('koda', 'KODA-1', dto, { type: 'AGENT', id: 'agent-1' });

      expect(mockTicketLinkRepo.createLink).toHaveBeenCalledWith(
        expect.objectContaining({ createdByUserId: null, createdByAgentId: 'agent-1' }),
      );
    });

    it('records no creator when the caller passes none', async () => {
      await service.create('koda', 'KODA-1', dto);

      expect(mockTicketLinkRepo.createLink).toHaveBeenCalledWith(
        expect.objectContaining({ createdByUserId: null, createdByAgentId: null }),
      );
    });

    it('does not touch an existing link, so its original creator is preserved', async () => {
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue({ ...mockLink, createdByUserId: 'user-1' });

      const result = await service.create('koda', 'KODA-1', dto, { type: 'USER', id: 'user-2' });

      expect(result.status).toBe(200);
      expect(mockTicketLinkRepo.createLink).not.toHaveBeenCalled();
    });

    it('does not expose the creator in the response, which is unchanged', async () => {
      const result = await service.create('koda', 'KODA-1', dto, { type: 'USER', id: 'user-1' });

      expect(result.link).not.toHaveProperty('createdByUserId');
      expect(result.link).not.toHaveProperty('createdByAgentId');
      expectLinkDto(result.link, mockLink);
    });
  });

  describe('remove', () => {
    const principal: KodaPrincipal = userPrincipal;

    it('deletes a link by id when it belongs to the ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(mockLink);
      mockTicketLinkRepo.deleteLink.mockResolvedValue(undefined);

      await service.remove('koda', 'KODA-1', 'link-123', principal);

      expect(mockTicketLinkRepo.deleteLink).toHaveBeenCalledWith('link-123');
    });

    // US-006: the row-level half of the check — the route declares
    // `ticket.link.remove` with enforcedBy 'service', so the creator is compared here.
    it('checks ticket.link.remove against the project and the link creator', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue({
        ...mockLink,
        createdByUserId: 'user-1',
      });
      mockTicketLinkRepo.deleteLink.mockResolvedValue(undefined);

      await service.remove('koda', 'KODA-1', 'link-123', principal);

      expect(mockPermissions.can).toHaveBeenCalledWith(principal, 'ticket.link.remove', {
        projectId: 'proj-123',
        resource: { createdBy: { type: 'USER', id: 'user-1' } },
      });
    });

    it('refuses with a permissions 403 and does not delete when the key is denied', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue({
        ...mockLink,
        createdByUserId: 'someone-else',
      });
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-owner' });

      const failure = service.remove('koda', 'KODA-1', 'link-123', principal);

      await expect(failure).rejects.toBeInstanceOf(ForbiddenAppException);
      await expect(failure).rejects.toMatchObject({ code: 40003, prefix: 'permissions' });
      expect(mockTicketLinkRepo.deleteLink).not.toHaveBeenCalled();
    });

    it('passes a null creator for a creatorless link so only the full key can remove it', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(mockLink);

      await service.remove('koda', 'KODA-1', 'link-123', principal);

      expect(mockPermissions.can).toHaveBeenCalledWith(principal, 'ticket.link.remove', {
        projectId: 'proj-123',
        resource: { createdBy: null },
      });
    });

    it('throws NotFoundException when linkId does not exist on that ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-1', 'nonexistent-link', principal),
      ).rejects.toThrow();

      // The lookup comes first: an unknown link is a 404, never a 403.
      expect(mockPermissions.can).not.toHaveBeenCalled();
    });

    it('does not delete when link belongs to a different ticket', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
      // findLinkByIdAndTicket scoped to ticketId returns null (link exists but for another ticket)
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-1', 'link-other-ticket', principal),
      ).rejects.toThrow();

      expect(mockTicketLinkRepo.deleteLink).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.remove('nonexistent', 'KODA-1', 'link-123', principal),
      ).rejects.toThrow();
    });

    it('throws NotFoundException when ticket ref does not exist', async () => {
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue(null);

      await expect(
        service.remove('koda', 'KODA-999', 'link-123', principal),
      ).rejects.toThrow();
    });
  });

  // H5: a KEY-N ref whose prefix differs from the project's key must never
  // resolve locally — not even to the project's own ticket with that number.
  describe('H5 foreign KEY prefix (OTHER-5 against project key KODA)', () => {
    const dto: CreateTicketLinkDto = {
      url: 'https://github.com/owner/repo/pull/1',
    };

    beforeEach(() => {
      // Project owns #5, so an unscoped number lookup WOULD resolve — the
      // prefix check is what must make these 404.
      mockTicketLinkRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-123', key: 'KODA' });
      mockTicketLinkRepo.findTicketByNumber.mockResolvedValue({ id: 'ticket-123' });
    });

    it('create → 404 and never looks up the ticket by bare number', async () => {
      await expect(service.create('koda', 'OTHER-5', dto)).rejects.toThrow();
      expect(mockTicketLinkRepo.findTicketByNumber).not.toHaveBeenCalled();
      expect(mockTicketLinkRepo.createLink).not.toHaveBeenCalled();
    });

    it('findByTicket → 404', async () => {
      await expect(service.findByTicket('koda', 'OTHER-5')).rejects.toThrow();
      expect(mockTicketLinkRepo.findLinksByTicket).not.toHaveBeenCalled();
    });

    it('remove → 404 and never deletes', async () => {
      mockTicketLinkRepo.findLinkByIdAndTicket.mockResolvedValue(mockLink);
      mockTicketLinkRepo.deleteLink.mockResolvedValue(undefined);

      await expect(service.remove('koda', 'OTHER-5', 'link-123', userPrincipal)).rejects.toThrow();
      expect(mockTicketLinkRepo.findLinkByIdAndTicket).not.toHaveBeenCalled();
      expect(mockTicketLinkRepo.deleteLink).not.toHaveBeenCalled();
    });

    it('CUID refs are unaffected by the prefix rule (already project-scoped)', async () => {
      mockTicketLinkRepo.findTicketById.mockResolvedValue({ id: 'ticket-123' });
      mockTicketLinkRepo.findLinkByUrl.mockResolvedValue(null);
      mockTicketLinkRepo.createLink.mockResolvedValue(mockLink);

      const result = await service.create('koda', 'ticket-123', dto);

      expect(result.status).toBe(201);
      expect(mockTicketLinkRepo.findTicketById).toHaveBeenCalledWith('ticket-123', 'proj-123');
    });
  });
});
