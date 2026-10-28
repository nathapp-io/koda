import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { APPROVAL_GATED_METADATA } from '../approvals/route/approval-gated.decorator';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { Test, TestingModule } from '@nestjs/testing';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';
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

  let module: TestingModule;
  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [TicketLinksController],
      providers: [
        { provide: ApprovalRouteGate, useValue: { run: vi.fn() } },
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

  afterEach(async () => {
    await module?.close();
    vi.clearAllMocks();
  });

  describe('POST /projects/:slug/tickets/:ref/links', () => {
    it.each([200, 201])('AC-10: executed status %s returns only the link in the envelope', async (status) => {
      const gate = module.get(ApprovalRouteGate);
      vi.mocked(gate.run).mockResolvedValue({ status: 'executed', result: { status, link: mockLink } });
      const dto = { url: mockLink.url };
      const project = { project: { id: 'p1', slug: 'koda' } };
      const res = { statusCode: 201 };
      const result = await controller.create('koda', 'KODA-1', dto, principal, project, res);
      expect(result).toEqual(JsonResponse.Ok(mockLink));
      expect(res.statusCode).toBe(status);
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'ticket.link.add', variant: 'rest:ticket-links.add', projectId: 'p1', input: { slug: 'koda', ref: 'KODA-1', link: dto } });
      expect(service.create).not.toHaveBeenCalled();
      expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, controller.create)).toBe(true);
    });
    it('throws the pending outcome without calling the service', async () => {
      const gate = module.get(ApprovalRouteGate);
      const pending = { id: 'request-1' };
      vi.mocked(gate.run).mockResolvedValue({ status: 'pending', request: pending });
      await expect(controller.create('koda', 'KODA-1', { url: mockLink.url }, makeAgentPrincipal(), { project: { id: 'p1', slug: 'koda' } })).rejects.toMatchObject({ request: pending });
      expect(service.create).not.toHaveBeenCalled();
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
    it('gates the frozen identifiers and returns no body after execution', async () => {
      const gate = module.get(ApprovalRouteGate);
      vi.mocked(gate.run).mockResolvedValue({ status: 'executed', result: null });
      const result = await controller.remove('koda', 'KODA-1', 'link-123', { project: { id: 'p1', slug: 'koda' } });
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'ticket.link.remove', variant: 'rest:ticket-links.remove', projectId: 'p1', input: { slug: 'koda', ref: 'KODA-1', linkId: 'link-123' } });
      expect(service.remove).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });
});

describe('remove HTTP approval wrapper', () => {
  function build() {
    const run = vi.fn();
    const gate = { run } as unknown as ApprovalRouteGate;
    const service = { softDelete: vi.fn(), delete: vi.fn(), removeFromTicket: vi.fn(), remove: vi.fn() };
    const controller = new TicketLinksController(service as unknown as TicketLinksService, gate);
    const project = { project: { id: 'p1', slug: 'alpha' } };
    return { run, service, controller, invoke: () => controller.remove('alpha', 'AL-1', 'k1', project) };
  }
  it('maps execution and gates the frozen identifiers in CurrentProject scope', async () => {
    const { run, service, controller, invoke } = build();
    const result = { ref: 'AL-1' };
    run.mockResolvedValue({ status: 'executed', result });
    const output = await invoke();
    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'ticket.link.remove', variant: 'rest:ticket-links.remove', projectId: 'p1', input: { slug: 'alpha', ref: 'AL-1', linkId: 'k1' } });
    expect(output).toBeUndefined();
    for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, controller.remove)).toBe(true);
  });
  it('throws ApprovalPending with the unchanged request', async () => {
    const { run, invoke } = build();
    const request = { id: 'approval-1' };
    run.mockResolvedValue({ status: 'pending', request });
    const error = await invoke().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApprovalPending);
    expect((error as ApprovalPending).request).toBe(request);
  });
});
