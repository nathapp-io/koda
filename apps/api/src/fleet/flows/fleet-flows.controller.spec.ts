import { AppException } from '@nathapp/nestjs-common';
import { FleetFlowsController } from './fleet-flows.controller';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { RepoCheckReason } from '../git-broker/repo-check.exception';

const sha = 'a'.repeat(40);
const body = { remoteUrl: 'https://github.com/Org/Repo.git', branch: 'feat/flow-x', specSha: sha,
  features: [{ feature: 'flow-x', specPath: 'docs/one.md' }, { feature: 'flow-y', specPath: 'docs/two.md', dependsOn: ['flow-x'] }],
  roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25 };

function setup() {
  const repo = { id: 'repo-1', projectId: 'project-1', owner: 'org', name: 'repo', githubInstallationId: 77n };
  const repos = { findByIdentity: vi.fn().mockResolvedValue(repo) };
  const projects = { findAllForPrincipal: vi.fn().mockResolvedValue([{ id: 'project-1', slug: 'web' }]) };
  const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
  const forge = { mintReadOnlyToken: vi.fn().mockResolvedValue({ token: 'ephemeral-secret' }), getBranchHead: vi.fn().mockResolvedValue(sha),
    getFile: vi.fn().mockResolvedValue({ content: Buffer.from('spec') }) };
  const gate = { run: vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'create-ask' } }) };
  const controller = new FleetFlowsController(repos as never, projects as never, permissions as never, forge as never, gate as never, {} as never);
  const principal = { actorType: 'agent', id: 'agent-1' } as const;
  const send = (input: unknown = body) => controller.create(input, principal as never);
  return { repo, repos, projects, permissions, forge, gate, principal, send };
}

async function refusal(promise: Promise<unknown>, status: number, prefix: string, args?: Record<string, unknown>) {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppException);
  expect(error).toMatchObject({ status, response: { code: status, args: args ?? {}, prefix } });
}

describe('FleetFlowsController nax preflight (no database)', () => {
  it('AC-3/14: verifies every spec at the SHA before asking the project gate, retaining no token', async () => {
    const { send, forge, repos, gate, permissions, principal } = setup();
    await expect(send()).rejects.toMatchObject({ request: { id: 'create-ask' } });
    expect(repos.findByIdentity).toHaveBeenCalledWith('github', 'org', 'repo');
    expect(permissions.can).toHaveBeenCalledWith(principal, 'fleet.flow.create', { projectId: 'project-1' });
    expect(forge.mintReadOnlyToken).toHaveBeenCalledWith(77n, 'repo');
    expect(forge.getBranchHead).toHaveBeenCalledWith('ephemeral-secret', 'org', 'repo', body.branch);
    expect(forge.getFile.mock.calls).toEqual(body.features.map(({ specPath }) => ['ephemeral-secret', 'org', 'repo', specPath, sha]));
    expect(gate.run).toHaveBeenCalledOnce();
    expect(forge.getFile.mock.invocationCallOrder.every((order) => order < gate.run.mock.invocationCallOrder[0])).toBe(true);
    expect(gate.run.mock.calls[0][0]).toMatchObject({ key: 'fleet.flow.create', projectId: 'project-1', input: {
      repoId: 'repo-1', projectId: 'project-1', body: { ...body, costCapUsd: '25', features: body.features.map((feature) => ({ dependsOn: [], ...feature })) },
    } });
    expect(JSON.stringify(gate.run.mock.calls)).not.toContain('ephemeral-secret');
  });

  it.each(['unknown', 'inaccessible'])('AC-4/5: hides %s repos without forge calls or a gate request', async (which) => {
    const { send, repos, projects, forge, gate } = setup();
    if (which === 'unknown') repos.findByIdentity.mockResolvedValue(null);
    else projects.findAllForPrincipal.mockResolvedValue([]);
    await refusal(send(), 404, 'fleet.flows.repoNotFound');
    expect(forge.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-6: refuses a reachable repo without the create key before minting', async () => {
    const { send, permissions, forge, gate } = setup();
    permissions.can.mockResolvedValue({ allowed: false });
    await expect(send()).rejects.toMatchObject({ status: 403, response: { code: 40003, prefix: 'permissions' } });
    expect(forge.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-7: translates a missing branch', async () => {
    const { send, forge, gate } = setup();
    forge.getBranchHead.mockRejectedValue(new RepoCheckException('repo_not_found'));
    await refusal(send(), 409, 'fleet.flows.branchNotFound');
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-8: refuses a non-head SHA without checking files or asking the gate', async () => {
    const { send, forge, gate } = setup();
    forge.getBranchHead.mockResolvedValue('b'.repeat(40));
    await refusal(send(), 409, 'fleet.flows.specShaNotHead');
    expect(forge.getFile).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-9: names the second missing spec and does not ask the gate', async () => {
    const { send, forge, gate } = setup();
    forge.getFile.mockResolvedValueOnce({ content: Buffer.from('spec') }).mockResolvedValueOnce(null);
    await refusal(send(), 422, 'fleet.flows.specMissing', { path: 'docs/two.md' });
    expect(gate.run).not.toHaveBeenCalled();
  });

  it.each< [string, 'mintReadOnlyToken' | 'getBranchHead' | 'getFile', RepoCheckReason]>([
    ['AC-10', 'getBranchHead', 'provider_unreachable'], ['AC-10', 'getBranchHead', 'provider_error'],
    ['AC-11', 'mintReadOnlyToken', 'github_app_not_configured'], ['AC-11', 'mintReadOnlyToken', 'github_app_key_unreadable'],
    ['AC-12', 'mintReadOnlyToken', 'app_not_installed'], ['AC-12', 'mintReadOnlyToken', 'app_permissions_insufficient'],
    ['extra', 'getFile', 'provider_error'],
  ])('%s: translates %s %s without gate writes', async (_ac, method, reason) => {
    const { send, forge, gate } = setup();
    forge[method].mockRejectedValue(new RepoCheckException(reason));
    const disconnected = reason === 'app_not_installed' || reason === 'app_permissions_insufficient';
    await refusal(send(), disconnected ? 409 : 503, disconnected ? 'fleet.flows.repoNotConnected' : 'fleet.flows.forgeUnavailable');
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-12: refuses an unconnected repo before minting', async () => {
    const { send, repos, repo, forge, gate } = setup();
    repos.findByIdentity.mockResolvedValue({ ...repo, githubInstallationId: null });
    await refusal(send(), 409, 'fleet.flows.repoNotConnected');
    expect(forge.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('invalid remoteUrl is a named validation error, not skills.unsupportedHost', async () => {
    const { send, repos, gate } = setup();
    await expect(send({ ...body, remoteUrl: 'git@github.com:org/repo.git' })).rejects.toMatchObject({ args: { reason: 'remoteUrl' } });
    expect(repos.findByIdentity).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('unexpected forge errors are not swallowed', async () => {
    const { send, forge, gate } = setup();
    const error = new Error('unexpected failure');
    forge.getFile.mockRejectedValue(error);
    await expect(send()).rejects.toBe(error);
    expect(gate.run).not.toHaveBeenCalled();
  });
});
