import { ValidationAppException } from '@nathapp/nestjs-common';
import { validateSync } from 'class-validator';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { UpdateAgentDto } from '../agents/dto/update-agent.dto';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectsController } from './projects.controller';
import type { ProjectContext } from './project-context';

describe('ProjectsController.updateProjectAgent shutdown-only self updates', () => {
  const ctx: ProjectContext = { project: { id: 'project-id', slug: 'alpha' } };
  const self: KodaPrincipal = {
    actorType: 'agent', id: 'agent-id', name: 'agent-a', slug: 'agent-a', status: 'ACTIVE',
    agentRoles: ['DEVELOPER'], capabilities: [], blacklisted: false, revoked: false, authorities: ['WORKER'],
  };
  let agentsService: { isOnProjectRosterBySlug: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findRosteredAgentIdentity: ReturnType<typeof vi.fn> };
  let permissions: { can: ReturnType<typeof vi.fn> };
  let routeGate: { run: ReturnType<typeof vi.fn> };
  let controller: ProjectsController;

  beforeEach(() => {
    agentsService = {
      isOnProjectRosterBySlug: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue({ slug: 'agent-a' }),
      findRosteredAgentIdentity: vi.fn().mockResolvedValue({ projectId: 'project-id', agentId: 'agent-id' }),
    };
    permissions = { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) };
    routeGate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { slug: 'agent-a' } }) };
    controller = new ProjectsController({} as never, {} as never, agentsService as never, permissions as never, routeGate as unknown as ApprovalRouteGate);
  });

  it.each([
    ['OFFLINE', { status: 'OFFLINE' }],
    ['PAUSED', { status: 'PAUSED' }],
  ] as const)('allows self shutdown status %s', async (_status, patch) => {
    await controller.updateProjectAgent('alpha', 'agent-a', patch, self, ctx);
    expect(agentsService.update).toHaveBeenCalledExactlyOnceWith('agent-a', patch);
    expect(routeGate.run).not.toHaveBeenCalled();
    expect(permissions.can).not.toHaveBeenCalled();
  });

  it('strips unknown properties before applying allowed shutdown', async () => {
    await controller.updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE', junk: 1 } as never, self, ctx);
    expect(agentsService.update).toHaveBeenCalledExactlyOnceWith('agent-a', { status: 'OFFLINE' });
  });

  it.each([
    { status: 'ACTIVE' },
    { status: 'OFFLINE', maxConcurrentTickets: 5 },
    { name: 'Owner' },
    {},
  ])('forbids non-shutdown self patch %#', async (patch) => {
    await expect(controller.updateProjectAgent('alpha', 'agent-a', patch, self, ctx))
      .rejects.toMatchObject({ prefix: 'projectAgents' });
    expect(agentsService.update).not.toHaveBeenCalled();
    expect(routeGate.run).not.toHaveBeenCalled();
  });

  it('preserves parseBody validation errors for invalid self patch', async () => {
    await expect(controller.updateProjectAgent('alpha', 'agent-a', { status: 'GONE' } as never, self, ctx))
      .rejects.toThrow(ValidationAppException);
    expect(agentsService.update).not.toHaveBeenCalled();
  });

  it('uses the existing approval gate for a non-self target', async () => {
    const other: KodaPrincipal = { actorType: 'user', id: 'user-id', name: 'u', email: 'u@example.test', role: 'MEMBER', blacklisted: false, revoked: false, authorities: ['MEMBER'], extra: { sub: 'user-id' } };
    await controller.updateProjectAgent('alpha', 'agent-b', { status: 'PAUSED' }, other, ctx);
    expect(routeGate.run).toHaveBeenCalledExactlyOnceWith({
      key: 'agent.update', variant: 'rest:project-agents.update', projectId: null,
      input: { slug: 'alpha', agentSlug: 'agent-b', projectId: 'project-id', agentId: 'agent-id', patch: { status: 'PAUSED' } },
      keyCheck: false,
    });
  });
});

describe('UpdateAgentDto maxConcurrentTickets validation', () => {
  it.each([1.5, 0])('rejects %s', (maxConcurrentTickets) => {
    expect(validateSync(Object.assign(new UpdateAgentDto(), { maxConcurrentTickets })).map((error) => error.property))
      .toContain('maxConcurrentTickets');
  });

  it('accepts positive integers', () => {
    expect(validateSync(Object.assign(new UpdateAgentDto(), { maxConcurrentTickets: 3 }))).toEqual([]);
  });
});
