import type { Mock } from 'vitest';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from '../../../src/projects/prisma-project.repository';
import { ProjectAccessService, PROJECT_ACCESS_KEY } from '../../../src/projects/project-access.service';
import type { PermissionService } from '../../../src/permissions/permission.service';
import type { AgentPrincipal, KodaPrincipal, RunnerPrincipal } from '../../../src/auth/principal/koda-principal.types';

/**
 * US-001: an agent's project reach — and a runner's exemption — goes through
 * `PermissionService.can(principal, 'project.read', { projectId })`. The repository stub below answers
 * the legacy roster read only: the cases invert it on purpose, so an agent admitted with the roster
 * reading `false` (and refused with it reading `true`) can only be following the key.
 */
const agent: AgentPrincipal = {
  actorType: 'agent', id: 'agent-a', sub: 'agent-a', slug: 'agent-a', status: 'ACTIVE',
  agentRoles: [], capabilities: [], name: 'Agent A', blacklisted: false, revoked: false,
  authorities: ['WORKER'],
};
const runner: RunnerPrincipal = {
  actorType: 'runner', id: 'runner-a', sub: 'runner-a', runnerName: 'runner-a',
  labels: [], enabled: true, capacity: 1, name: 'Runner A', blacklisted: false, revoked: false,
  authorities: ['RUNNER'],
};

type ProjectRepositoryDouble = {
  isAgentOnRoster: Mock<(...args: [string, string]) => Promise<boolean>>;
  findMembershipRole: Mock;
};

const granted = { allowed: true, reason: 'granted' } as const;
const refused = { allowed: false, reason: 'not-granted' } as const;

function setup() {
  const repo: ProjectRepositoryDouble = {
    isAgentOnRoster: vi.fn<(...args: [string, string]) => Promise<boolean>>(),
    findMembershipRole: vi.fn(),
  };
  const can = vi.fn(async (_principal: KodaPrincipal, key: string) =>
    key === PROJECT_ACCESS_KEY ? granted : refused,
  );
  const service = new ProjectAccessService(
    repo as unknown as PrismaProjectRepository,
    { can } as unknown as PermissionService,
  );
  return { repo, service, can };
}

/** The rejection of `promise`, asserted to be a 403 — or a test failure. */
async function refusalOf(promise: Promise<unknown>): Promise<ForbiddenAppException> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ForbiddenAppException);
  return error as ForbiddenAppException;
}

describe('US-001 ProjectAccessService agent and runner access', () => {
  it('US-001 AC4: admits an agent whose project.read is granted, whatever the roster says', async () => {
    const { repo, service, can } = setup();
    repo.isAgentOnRoster.mockResolvedValue(false);

    await expect(service.resolveMembership('project-a', agent)).resolves.toBeNull();
    expect(can).toHaveBeenCalledWith(agent, PROJECT_ACCESS_KEY, { projectId: 'project-a' });
    expect(repo.isAgentOnRoster).not.toHaveBeenCalled();
  });

  it('US-001 AC5: forbids an agent whose project.read is refused with a projects-scoped 403', async () => {
    const { repo, service, can } = setup();
    repo.isAgentOnRoster.mockResolvedValue(true);
    can.mockResolvedValue(refused);

    const error = await refusalOf(service.resolveMembership('project-a', agent));

    expect(error.prefix).toBe('projects');
    expect(can).toHaveBeenCalledWith(agent, PROJECT_ACCESS_KEY, { projectId: 'project-a' });
    expect(repo.isAgentOnRoster).not.toHaveBeenCalled();
  });

  it('US-001 AC7: leaves runner access unscoped without asking for a key or a roster row', async () => {
    const { repo, service, can } = setup();

    await expect(service.resolveMembership('project-a', runner)).resolves.toBeNull();
    expect(can).not.toHaveBeenCalled();
    expect(repo.isAgentOnRoster).not.toHaveBeenCalled();
    await expect(service.readsEveryProject(runner)).resolves.toBe(false);
    expect(can).not.toHaveBeenCalled();
  });

  it('US-001 AC8: surfaces a permission database error unchanged', async () => {
    const { service, can } = setup();
    const databaseError = new Error('roster database unavailable');
    can.mockRejectedValue(databaseError);

    await expect(service.resolveMembership('project-a', agent)).rejects.toBe(databaseError);
  });
});
