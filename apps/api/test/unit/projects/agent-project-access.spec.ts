import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from '../../../src/projects/prisma-project.repository';
import { ProjectAccessService } from '../../../src/projects/project-access.service';
import type { AgentPrincipal, RunnerPrincipal } from '../../../src/auth/principal/koda-principal.types';

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
  isAgentOnRoster: jest.Mock<Promise<boolean>, [string, string]>;
  findMembershipRole: jest.Mock;
};

function setup() {
  const repo: ProjectRepositoryDouble = {
    isAgentOnRoster: jest.fn<Promise<boolean>, [string, string]>(),
    findMembershipRole: jest.fn(),
  };
  const service = new ProjectAccessService(repo as unknown as PrismaProjectRepository);
  return { repo, service };
}

describe('US-001 ProjectAccessService agent roster enforcement', () => {
  it('US-001 AC4: allows an agent whose project roster lookup succeeds', async () => {
    const { repo, service } = setup();
    repo.isAgentOnRoster.mockResolvedValue(true);

    await expect(service.resolveMembership('project-a', agent)).resolves.toBeNull();
    expect(repo.isAgentOnRoster).toHaveBeenCalledWith('project-a', 'agent-a');
  });

  it('US-001 AC5: forbids an agent absent from the project roster', async () => {
    const { repo, service } = setup();
    repo.isAgentOnRoster.mockResolvedValue(false);

    await expect(service.resolveMembership('project-a', agent)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('US-001 AC6: bypasses roster lookup when agent project scoping is disabled', async () => {
    const repo: ProjectRepositoryDouble = {
      isAgentOnRoster: jest.fn<Promise<boolean>, [string, string]>(),
      findMembershipRole: jest.fn(),
    };
    const service = Reflect.construct(ProjectAccessService, [repo, { agentProjectScoping: false }]);
    const enabled = Reflect.get(service, 'agentScopingEnabled');
    expect(enabled).toEqual(expect.any(Function));
    if (typeof enabled === 'function') expect(enabled.call(service)).toBe(false);

    await expect(service.resolveMembership('project-a', agent)).resolves.toBeNull();
    expect(repo.isAgentOnRoster).not.toHaveBeenCalled();
  });

  it('US-001 AC7: leaves runner access unscoped without looking up an agent roster row', async () => {
    const { repo, service } = setup();

    await expect(service.resolveMembership('project-a', runner)).resolves.toBeNull();
    expect(repo.isAgentOnRoster).not.toHaveBeenCalled();
  });

  it('US-001 AC8: surfaces a roster database error unchanged', async () => {
    const { repo, service } = setup();
    const databaseError = new Error('roster database unavailable');
    repo.isAgentOnRoster.mockRejectedValue(databaseError);

    await expect(service.resolveMembership('project-a', agent)).rejects.toBe(databaseError);
  });
});
