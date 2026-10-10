import type { Mock } from 'vitest';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from '../../../src/projects/prisma-project.repository';
import { ProjectAccessService } from '../../../src/projects/project-access.service';
import type { IAuthConfig } from '../../../src/config/auth.config';
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
  isAgentOnRoster: Mock<(...args: [string, string]) => Promise<boolean>>;
  findMembershipRole: Mock;
};

function setup(authConfig?: Partial<IAuthConfig>) {
  const repo: ProjectRepositoryDouble = {
    isAgentOnRoster: vi.fn<(...args: [string, string]) => Promise<boolean>>(),
    findMembershipRole: vi.fn(),
  };
  const service = new ProjectAccessService(
    repo as unknown as PrismaProjectRepository,
    authConfig as IAuthConfig | undefined,
  );
  return { repo, service };
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

describe('US-001 ProjectAccessService agent roster enforcement', () => {
  it('US-001 AC4: allows an agent whose project roster lookup succeeds', async () => {
    const { repo, service } = setup();
    repo.isAgentOnRoster.mockResolvedValue(true);

    await expect(service.resolveMembership('project-a', agent)).resolves.toBeNull();
    expect(repo.isAgentOnRoster).toHaveBeenCalledWith('project-a', 'agent-a');
  });

  it('US-001 AC5: forbids an agent absent from the project roster with a projects-scoped 403', async () => {
    const { repo, service } = setup();
    repo.isAgentOnRoster.mockResolvedValue(false);

    const error = await refusalOf(service.resolveMembership('project-a', agent));

    expect(error.prefix).toBe('projects');
    expect(repo.isAgentOnRoster).toHaveBeenCalledWith('project-a', 'agent-a');
  });

  it('US-001 AC6: bypasses the roster lookup when agent project scoping is disabled', async () => {
    const { repo, service } = setup({ agentProjectScoping: false });

    await expect(service.resolveMembership('project-a', agent)).resolves.toBeNull();
    expect(repo.isAgentOnRoster).not.toHaveBeenCalled();
  });

  it('US-001 AC6 boundary: an explicit scoping config of true still consults the roster', async () => {
    const { repo, service } = setup({ agentProjectScoping: true });
    repo.isAgentOnRoster.mockResolvedValue(true);

    await expect(service.resolveMembership('project-a', agent)).resolves.toBeNull();
    expect(repo.isAgentOnRoster).toHaveBeenCalledWith('project-a', 'agent-a');
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
