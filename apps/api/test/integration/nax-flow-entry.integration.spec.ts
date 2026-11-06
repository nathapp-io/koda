import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { grantKeys, seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { FleetFlowsService } from '../../src/fleet/flows/fleet-flows.service';
import type { FleetFlowDto } from '../../src/fleet/flows/dto/fleet-flow.dto';
import { FleetReposService } from '../../src/fleet/repos/fleet-repos.service';
import { GitHubAppClient } from '../../src/fleet/git-broker/github-app-client';
import { RepoCheckException, type RepoCheckReason } from '../../src/fleet/git-broker/repo-check.exception';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { fixtureDb } from '../helpers/action-context';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp, data, resetThrottle } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
const sha = 'a'.repeat(40);
const input = { remoteUrl: 'https://github.com/Org/Repo.git', branch: 'feat/flow-x', specSha: sha,
  features: [{ feature: 'flow-x', specPath: 'docs/one.md' }, { feature: 'flow-y', specPath: 'docs/two.md', dependsOn: ['flow-x'] }],
  roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25 };
const features = input.features.map((feature) => ({ dependsOn: [], ...feature }));

function refusal(response: request.Response, key: string, args: Record<string, string> = {}) {
  const [namespace, ...segments] = key.split('.');
  const catalog: unknown = JSON.parse(readFileSync(join(__dirname, '../../src/i18n/en', `${namespace}.json`), 'utf8'));
  const sentence = segments.reduce<unknown>((node, segment) => typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined, catalog);
  expect(typeof sentence).toBe('string');
  expect(response.body).toEqual({ ret: Number(segments.at(-1)), message: String(sentence).replace(/\{(\w+)\}/g, (placeholder, name: string) => args[name] ?? placeholder) });
}

describeDb('nax flow entry endpoint', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let viewer: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const outsideTransaction: boolean[] = [];
  let head: ReturnType<typeof vi.spyOn<GitHubAppClient, 'getBranchHead'>>;
  let file: ReturnType<typeof vi.spyOn<GitHubAppClient, 'getFile'>>;
  let mint: ReturnType<typeof vi.spyOn<GitHubAppClient, 'mintReadOnlyToken'>>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    await db.fleetRepo.update({ where: { id: world.repoId }, data: { owner: 'org', name: 'repo' } });
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.flow.create'], world.projectId);
    viewer = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantRole(db, { type: 'AGENT', id: viewer.id }, 'viewer', world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    resetThrottle(app);
    outsideTransaction.length = 0;
    const check = () => { outsideTransaction.push(!app.get<ITransactionManager>(TRANSACTION_MANAGER).isInTransaction()); };
    const github = app.get(GitHubAppClient);
    mint = vi.spyOn(github, 'mintReadOnlyToken').mockImplementation(async () => { check(); return { token: 'ephemeral-secret', expiresAt: new Date() }; });
    head = vi.spyOn(github, 'getBranchHead').mockImplementation(async () => { check(); return sha; });
    file = vi.spyOn(github, 'getFile').mockImplementation(async () => { check(); return { sha, size: 4, content: Buffer.from('spec') }; });
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.fleetActivity.deleteMany({ where: { entityType: 'flow' } });
    await db.auditEntry.deleteMany({ where: { key: 'fleet.flow.create' } });
    await db.fleetRepo.update({ where: { id: world.repoId }, data: { githubInstallationId: 77n } });
  });
  const post = (body: unknown = input, token?: string) => request(app.getHttpServer()).post('/api/fleet/flows').set('Authorization', `Bearer ${token ?? agent.apiKey}`).send(body);
  async function noWrites() {
    expect(await db.fleetFlow.count()).toBe(0);
    expect(await db.fleetFlowFeature.count()).toBe(0);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetActivity.count({ where: { entityType: 'flow' } })).toBe(0);
    expect(await db.auditEntry.count({ where: { key: 'fleet.flow.create' } })).toBe(0);
  }

  it('AC-1/3: creates a PENDING NAX flow for a rostered agent after read-only forge verification outside a transaction', async () => {
    const flow = data<FleetFlowDto>(await post().expect(201));
    expect(flow).toMatchObject({ entry: 'NAX', threadId: null, state: 'PENDING', repoId: world.repoId, projectId: world.projectId,
      branch: input.branch, specSha: sha, features, roles: input.roles, costCapUsd: '25.0000', createdBy: { type: 'AGENT', id: agent.id } });
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ entry: 'NAX', threadId: null, state: 'PENDING', createdByType: 'AGENT', createdById: agent.id });
    expect(mint).toHaveBeenCalledWith(77n, 'repo');
    expect(head).toHaveBeenCalledWith('ephemeral-secret', 'org', 'repo', input.branch);
    expect(file.mock.calls).toEqual(input.features.map(({ specPath }) => ['ephemeral-secret', 'org', 'repo', specPath, sha]));
    expect(outsideTransaction).toEqual([true, true, true, true]);
    expect(await db.approvalRequest.count()).toBe(1);
    const persisted = [await db.fleetFlow.findMany(), await db.approvalRequest.findMany(), await db.auditEntry.findMany(), await db.fleetActivity.findMany()];
    expect(JSON.stringify(persisted)).not.toContain('ephemeral-secret');
  });

  it('AC-2: delegates once with NAX, resolved identities, normalized input and the agent creator', async () => {
    // Call through to preserve the real DTO shape; the spy is then a stub for the second request.
    const original = data<FleetFlowDto>(await post().expect(201));
    const row = await db.fleetFlow.findUniqueOrThrow({ where: { id: original.id } });
    const service = app.get(FleetFlowsService);
    const create = vi.spyOn(service, 'create').mockResolvedValue({ approvalRequestId: row.approvalRequestId, flow: {
      ...row, entry: 'NAX', state: 'PENDING', createdByType: 'AGENT', approvalMode: null, stopReason: null, costCapUsd: row.costCapUsd.toString(), spentUsd: row.spentUsd.toString(), features: features.map((feature, position) => ({ ...feature, id: `stub-${position}`, flowId: row.id, position, state: 'PENDING', currentStep: null, prNumber: null })),
    } });
    await post({ ...input, repoId: world.foreignRepoId, projectId: world.opsProjectId, createdBy: { type: 'USER', id: world.ids.root } }).expect(201);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ entry: 'NAX', repoId: world.repoId, branch: input.branch, specSha: sha, features, roles: input.roles, costCapUsd: '25' },
      { type: 'AGENT', id: agent.id }, { projectId: world.projectId });
  });

  it.each([
    ['AC-4', 'https://github.com/other/repo'], ['AC-5', 'https://github.com/acme/ops'],
  ])('%s: hides unknown and inaccessible repositories', async (_ac, remoteUrl) => {
    refusal(await post({ ...input, remoteUrl }).expect(404), 'fleet.flows.repoNotFound.404');
    expect(mint).not.toHaveBeenCalled();
    await noWrites();
  });
  it('AC-6: refuses a rostered viewer agent without the create key', async () => {
    refusal(await post(input, viewer.apiKey).expect(403), 'permissions.40003');
    expect(mint).not.toHaveBeenCalled();
    await noWrites();
  });
  it('AC-7: translates branch not found', async () => {
    head.mockRejectedValue(new RepoCheckException('repo_not_found'));
    refusal(await post().expect(409), 'fleet.flows.branchNotFound.409');
    await noWrites();
  });
  it('AC-8: refuses a stale SHA', async () => {
    head.mockResolvedValue('b'.repeat(40));
    refusal(await post().expect(409), 'fleet.flows.specShaNotHead.409');
    await noWrites();
  });
  it('AC-9: names the second missing spec path', async () => {
    file.mockResolvedValueOnce({ sha, size: 4, content: Buffer.from('spec') }).mockResolvedValueOnce(null);
    refusal(await post().expect(422), 'fleet.flows.specMissing.422', { path: input.features[1].specPath });
    await noWrites();
  });
  it.each<[string, 'head' | 'mint', RepoCheckReason, number, string]>([
    ['AC-10', 'head', 'provider_unreachable', 503, 'forgeUnavailable'], ['AC-10', 'head', 'provider_error', 503, 'forgeUnavailable'],
    ['AC-11', 'mint', 'github_app_not_configured', 503, 'forgeUnavailable'], ['AC-11', 'mint', 'github_app_key_unreadable', 503, 'forgeUnavailable'],
    ['AC-12', 'mint', 'app_not_installed', 409, 'repoNotConnected'], ['AC-12', 'mint', 'app_permissions_insufficient', 409, 'repoNotConnected'],
  ])('%s: translates %s %s', async (_ac, method, reason, status, key) => {
    (method === 'head' ? head : mint).mockRejectedValue(new RepoCheckException(reason));
    refusal(await post().expect(status), `fleet.flows.${key}.${status}`);
    await noWrites();
  });
  it('AC-12: refuses a repo with no installation id', async () => {
    await db.fleetRepo.update({ where: { id: world.repoId }, data: { githubInstallationId: null } });
    refusal(await post().expect(409), 'fleet.flows.repoNotConnected.409');
    expect(mint).not.toHaveBeenCalled();
    await noWrites();
  });
  it('AC-13: duplicate send preserves the first flow and single start request', async () => {
    const first = data<FleetFlowDto>(await post().expect(201));
    const create = vi.spyOn(app.get(FleetFlowsService), 'create');
    const response = await post().expect(409);
    refusal(response, 'fleet.flows.duplicate.409', { flowId: first.id });
    expect(response.body.message).toContain(first.id);
    await expect(create.mock.results[0].value).rejects.toMatchObject({ args: { flowId: first.id } });
    expect(await db.fleetFlow.count()).toBe(1);
    expect(await db.approvalRequest.count()).toBe(1);
  });
  it('AC-14: agent policy asks first; approval creates as the agent with no further forge calls', async () => {
    const policy = await seedWaitPolicy(db, 'fleet.flow.create', world.projectId);
    try {
      const pending = data<{ id: string; permissionKey: string }>(await post().expect(202));
      expect(pending.permissionKey).toBe('fleet.flow.create');
      expect(await db.fleetFlow.count()).toBe(0);
      const ask = await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
      expect(ask).toMatchObject({ actorId: agent.id, actorType: 'AGENT', projectId: world.projectId, requiredMode: 'agent', input: {
        projectId: world.projectId, repoId: world.repoId, body: { ...input, features, costCapUsd: '25' },
      } });
      expect(JSON.stringify(ask)).not.toContain('ephemeral-secret');
      const response = await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' }).expect(200);
      expect(data<{ status: string }>(response).status).toBe('executed');
      expect(await db.fleetFlow.findMany()).toMatchObject([{ entry: 'NAX', createdByType: 'AGENT', createdById: agent.id, state: 'PENDING', repoId: world.repoId }]);
      expect(await db.fleetFlow.count()).toBe(1);
      expect(await db.approvalRequest.count()).toBe(2);
      expect(mint).toHaveBeenCalledOnce();
      expect(head).toHaveBeenCalledOnce();
      expect(file).toHaveBeenCalledTimes(2);
    } finally { await db.approvalPolicy.delete({ where: { id: policy.id } }); }
  });
  it('AC-15: case-insensitive identity lookup finds org/repo and not other/repo', async () => {
    const repos = app.get(FleetReposService);
    expect(await repos.findByIdentity('github', 'ORG', 'REPO')).toMatchObject({ id: world.repoId, owner: 'org', name: 'repo' });
    expect(await repos.findByIdentity('github', 'other', 'repo')).toBeNull();
  });
});
