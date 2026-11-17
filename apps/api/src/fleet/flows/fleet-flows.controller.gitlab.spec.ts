import { AppException } from '@nathapp/nestjs-common';
import { FleetFlowsController } from './fleet-flows.controller';
import { RepoCheckException, type RepoCheckReason } from '../git-broker/repo-check.exception';

const sha = 'a'.repeat(40);
const body = {
  remoteUrl: 'https://gitlab.com/grp/app', branch: 'feat/flow-x', specSha: sha,
  features: [{ feature: 'flow-x', specPath: 'docs/one.md' }, { feature: 'flow-y', specPath: 'docs/two.md' }],
  roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25,
};

function setup(options: { installationId?: bigint | null; repo?: boolean } = {}) {
  const repo = { id: 'repo-1', projectId: 'project-1', owner: 'grp', name: 'app', host: 'https://gitlab.com',
    provider: 'gitlab', githubInstallationId: options.installationId ?? null };
  const repos = { findGitLabByRemoteUrl: vi.fn().mockResolvedValue(options.repo === false ? null : repo), findByIdentity: vi.fn() };
  const projects = { findAllForPrincipal: vi.fn().mockResolvedValue([{ id: 'project-1', slug: 'web' }]) };
  const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
  const credentials = { call: vi.fn(async (_repo: unknown, _kind: string, fn: (access: { token: string }) => Promise<unknown>) => fn({ token: 'read-secret' })) };
  const gitlab = { getBranchHead: vi.fn().mockResolvedValue(sha), getFile: vi.fn().mockResolvedValue({ content: Buffer.from('spec') }) };
  const github = { mintReadOnlyToken: vi.fn(), getBranchHead: vi.fn(), getFile: vi.fn() };
  const gate = { run: vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'create-ask' } }) };
  const controller = new FleetFlowsController(repos as never, projects as never, permissions as never, github as never,
    gate as never, {} as never, credentials as never, gitlab as never);
  const principal = { actorType: 'agent', id: 'agent-1' } as const;
  return { repo, repos, projects, permissions, credentials, gitlab, github, gate, principal,
    send: (input: unknown = body) => controller.create(input, principal as never) };
}

async function refusal(promise: Promise<unknown>, status: number, prefix: string, args: Record<string, unknown> = {}) {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppException);
  expect(error).toMatchObject({ status, response: { code: status === 403 ? 40003 : status, args, prefix } });
}

describe('FleetFlowsController GitLab preflight', () => {
  it('AC-1/2/3: reads head and each spec through per-call credentials before gate, without GitHub lookup or methods', async () => {
    const { send, repo, repos, credentials, gitlab, github, gate } = setup();
    await expect(send()).rejects.toMatchObject({ request: { id: 'create-ask' } });
    expect(repos.findGitLabByRemoteUrl).toHaveBeenCalledWith(body.remoteUrl);
    expect(repos.findByIdentity).not.toHaveBeenCalled();
    expect(credentials.call).toHaveBeenCalledTimes(3);
    expect(gitlab.getBranchHead).toHaveBeenCalledWith({ token: 'read-secret' }, body.branch);
    expect(gitlab.getFile.mock.calls).toEqual(body.features.map(({ specPath }) => [{ token: 'read-secret' }, specPath, sha]));
    expect(gitlab.getFile.mock.invocationCallOrder.every((order) => order < gate.run.mock.invocationCallOrder[0])).toBe(true);
    expect(gate.run).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ projectId: 'project-1', repoId: repo.id, body: expect.objectContaining({ remoteUrl: body.remoteUrl }) }) }));
    expect(github.mintReadOnlyToken).not.toHaveBeenCalled();
    expect(github.getBranchHead).not.toHaveBeenCalled();
    expect(github.getFile).not.toHaveBeenCalled();
    expect(credentials.call).toHaveBeenNthCalledWith(1, repo, 'read', expect.any(Function));
  });

  it('AC-4: provider selects GitLab even when the row has an installation id', async () => {
    const { send, github, credentials } = setup({ installationId: 9n });
    await expect(send()).rejects.toMatchObject({ request: { id: 'create-ask' } });
    expect(credentials.call).toHaveBeenCalled();
    expect(github.mintReadOnlyToken).not.toHaveBeenCalled();
  });

  it('AC-5: an unresolved GitLab remote is not found', async () => {
    const { send } = setup({ repo: false });
    await refusal(send(), 404, 'fleet.flows.repoNotFound');
  });

  it('AC-6: inaccessible project is hidden before a GitLab call', async () => {
    const { send, projects, credentials } = setup();
    projects.findAllForPrincipal.mockResolvedValue([]);
    await refusal(send(), 404, 'fleet.flows.repoNotFound');
    expect(credentials.call).not.toHaveBeenCalled();
  });

  it('AC-7: missing project create permission refuses before a GitLab call', async () => {
    const { send, permissions, credentials } = setup();
    permissions.can.mockResolvedValue({ allowed: false });
    await refusal(send(), 403, 'permissions');
    expect(credentials.call).not.toHaveBeenCalled();
  });

  it('AC-8: rejects a spec sha that is not branch head before gate', async () => {
    const { send, gitlab, gate } = setup();
    gitlab.getBranchHead.mockResolvedValue('b'.repeat(40));
    await refusal(send(), 409, 'fleet.flows.specShaNotHead');
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-9: reports the missing spec path', async () => {
    const { send, gitlab, gate } = setup();
    gitlab.getFile.mockResolvedValueOnce({ content: Buffer.from('ok') }).mockResolvedValueOnce(null);
    await refusal(send(), 422, 'fleet.flows.specMissing', { path: 'docs/two.md' });
    expect(gate.run).not.toHaveBeenCalled();
  });

  it.each<RepoCheckReason>(['gitlab_credentials_missing', 'gitlab_token_invalid', 'app_permissions_insufficient'])('AC-10: maps %s to GitLab not connected', async (reason) => {
    const { send, credentials, gate } = setup();
    credentials.call.mockRejectedValue(new RepoCheckException(reason));
    await refusal(send(), 409, 'fleet.flows.gitlabNotConnected');
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-11: maps a missing branch to branch not found', async () => {
    const { send, gitlab, gate } = setup();
    gitlab.getBranchHead.mockRejectedValue(new RepoCheckException('repo_not_found'));
    await refusal(send(), 409, 'fleet.flows.branchNotFound');
    expect(gate.run).not.toHaveBeenCalled();
  });

  it.each<RepoCheckReason>(['provider_error', 'provider_unreachable', 'vcs_encryption_key_missing'])('AC-12: maps %s to forge unavailable', async (reason) => {
    const { send, gitlab, gate } = setup();
    gitlab.getBranchHead.mockRejectedValue(new RepoCheckException(reason));
    await refusal(send(), 503, 'fleet.flows.forgeUnavailable');
    expect(gate.run).not.toHaveBeenCalled();
  });

  it('AC-13: rethrows unrelated RepoCheckException unchanged', async () => {
    const { send, credentials } = setup();
    const error = new RepoCheckException('gitlab_host_blocked');
    credentials.call.mockRejectedValue(error);
    await expect(send()).rejects.toBe(error);
  });
});
