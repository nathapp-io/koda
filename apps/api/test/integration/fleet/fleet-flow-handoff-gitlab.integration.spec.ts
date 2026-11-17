import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { encryptToken } from '../../../src/common/utils/encryption.util';
import { GitLabAccessChecker } from '../../../src/fleet/git-broker/gitlab-access-checker';
import type { OpenPullRequest } from '../../../src/fleet/git-broker/github-app-client';

/**
 * US-005: the GitLab half of the nax-entry handoff create.
 *
 * The chat chain hands a feature over before publishing it; the flow that takes it over reads the
 * GitLab repository with the repo's read credential and refuses the handoff when the repository no
 * longer holds what the chain claimed. Every read fails closed: a refused handoff leaves no flow.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-flow-handoff-gitlab.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENC_KEY = 'c'.repeat(64);
const READ_TOKEN = 'glpat-read';

describeIntegration('GitLab nax handoff flow entry (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let repoId: string;
  const saved: Record<string, string | undefined> = {};

  const headSha = 'd'.repeat(40);
  const feature = 'handoff-gitlab';
  const prdPath = `.nax/features/${feature}/prd.json`;
  /** The chat run's record: its newest run is publishable at the head it hands over. */
  const record = [{ runId: 'run-gitlab-1', file: 'result.json', mtimeMs: 1763370000000,
    content: JSON.stringify({ schemaVersion: 1, featureWorkflow: { step: 'done', outcome: 'pushed', head: headSha } }) }];

  const server = () => app.getHttpServer();
  /** One handoff body per branch, so every case owns the branch it refuses or creates. */
  const handoffBody = (branch: string) => ({
    remoteUrl: 'https://gitlab.com/grp/app.git', branch,
    roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25,
    handoff: { feature, headSha, record },
  });
  const post = (body: unknown) => request(server()).post('/api/fleet/flows')
    .set('Authorization', `Bearer ${world.tokens.dev}`).send(body);
  const flowsOn = (branch: string) => db.fleetFlow.count({ where: { repoId, branch } });

  /** The branch the current case hands over; the PRD stub answers with it. */
  let currentBranch = 'feat/handoff-gitlab';

  /**
   * The GitLab reads a handoff create makes: the branch head, the PRD at that head and the open
   * merge requests of the project. The credential is the repo's own read token, so the stub sees it
   * in the access it is handed.
   */
  const withGitLab = (options: { head?: string; prd?: string | null; mergeRequests?: OpenPullRequest[] } = {}) => {
    const gitlab = app.get(GitLabAccessChecker);
    const head = vi.spyOn(gitlab, 'getBranchHead');
    const file = vi.spyOn(gitlab, 'getFile');
    const list = vi.spyOn(gitlab, 'listOpenMergeRequests');
    head.mockResolvedValue(options.head ?? headSha);
    file.mockImplementation(async () => options.prd === null
      ? null
      : { sha: 'prd-sha', size: 8, content: Buffer.from(options.prd ?? JSON.stringify({ branchName: currentBranch, userStories: [] })) });
    list.mockResolvedValue(options.mergeRequests ?? []);
    return {
      head, file, list,
      restore: () => { head.mockRestore(); file.mockRestore(); list.mockRestore(); },
    };
  };

  /**
   * The refusal message of the API, read from the English catalog: the key is the contract, and the
   * placeholders are filled with the arguments the refusal carries.
   */
  const refusal = (res: request.Response, key: string, args: Record<string, unknown> = {}): void => {
    const envelope = res.body as { ret: number; message: string };
    expect(envelope.ret).not.toBe(0);
    expect(envelope).not.toHaveProperty('data');
    const [namespace, ...segments] = key.split('.');
    const catalog = JSON.parse(
      readFileSync(join(__dirname, '../../../src/i18n/en', `${namespace}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const sentence = segments.reduce<unknown>(
      (node, segment) =>
        typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined,
      catalog,
    );
    expect(typeof sentence).toBe('string');
    expect(envelope.message).toBe(
      (sentence as string).replace(/\{(\w+)\}/g, (placeholder, name: string) =>
        name in args ? String(args[name]) : placeholder),
    );
  };

  beforeAll(async () => {
    saved['VCS_ENCRYPTION_KEY'] = process.env['VCS_ENCRYPTION_KEY'];
    process.env['VCS_ENCRYPTION_KEY'] = ENC_KEY;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    // The registered GitLab repository the handoff names: its own host, namespace and project name.
    const repo = await db.fleetRepo.create({ data: {
      projectId: world.projectId, provider: 'gitlab', owner: 'grp', name: 'app', host: 'https://gitlab.com',
      defaultBranch: 'main', createdById: world.ids.root,
    } });
    repoId = repo.id;
    await db.fleetRepoGitlabCredential.create({ data: {
      repoId, gitlabProjectId: 4711,
      encryptedReadToken: encryptToken(READ_TOKEN, ENC_KEY), encryptedWriteToken: encryptToken('glpat-write', ENC_KEY),
      readTokenUserId: 11, readTokenUsername: 'koda-read',
      writeTokenUserId: 12, writeTokenUsername: 'koda-bot', writeTokenIsBot: true,
    } });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (saved['VCS_ENCRYPTION_KEY'] === undefined) delete process.env['VCS_ENCRYPTION_KEY'];
    else process.env['VCS_ENCRYPTION_KEY'] = saved['VCS_ENCRYPTION_KEY'];
  });

  beforeEach(() => { resetThrottle(app); });

  it('US-005 AC-1: stores a PENDING flow whose one feature is the handed-over one', async () => {
    currentBranch = 'feat/handoff-gitlab-happy';
    const gitlab = withGitLab();
    try {
      const response = await post(handoffBody(currentBranch)).expect(201);
      const flow = data<{ id: string; state: string; entry: string; specSha: string; features: Record<string, unknown>[] }>(response);
      const row = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
      expect(row).toMatchObject({ state: 'PENDING', entry: 'NAX', specSha: headSha, branch: currentBranch, repoId });

      // The one feature of the flow carries the handoff flag.
      const features = await db.fleetFlowFeature.findMany({ where: { flowId: flow.id } });
      expect(features).toHaveLength(1);
      expect(features[0]).toMatchObject({ feature, specPath: `.nax/features/${feature}/spec.md`, dependsOn: [], handoff: true });

      // The read credential of the repo is the one the reads carry, and the listing is the
      // project's own open merge requests.
      expect(gitlab.head).toHaveBeenCalledWith(expect.objectContaining({ token: READ_TOKEN }), currentBranch);
      expect(gitlab.file).toHaveBeenCalledWith(expect.objectContaining({ token: READ_TOKEN }), prdPath, headSha);
      expect(gitlab.list).toHaveBeenCalledWith(expect.objectContaining({ token: READ_TOKEN }), 'grp/app');
      // One credential for every read, exactly as the GitHub form mints one thread read token.
      const access = gitlab.head.mock.calls[0]?.[0];
      expect(gitlab.file.mock.calls[0]?.[0]).toBe(access);
      expect(gitlab.list.mock.calls[0]?.[0]).toBe(access);
    } finally { gitlab.restore(); }
  });

  it('US-005 AC-2: refuses a handoff whose head already has an open merge request with 409', async () => {
    currentBranch = 'feat/handoff-gitlab-open-mr';
    const mergeRequests: OpenPullRequest[] = [{ number: 9, headSha, draft: false, headRepoFullName: 'grp/app', updatedAt: new Date() }];
    const gitlab = withGitLab({ mergeRequests });
    try {
      const response = await post(handoffBody(currentBranch)).expect(409);
      refusal(response, 'fleet.flows.handoffPrOpen.409', { prNumber: 9 });
      expect(await flowsOn(currentBranch)).toBe(0);
    } finally { gitlab.restore(); }
  });

  it('US-005 AC-3: refuses a handoff whose branch head moved with 409', async () => {
    currentBranch = 'feat/handoff-gitlab-moved';
    const gitlab = withGitLab({ head: 'e'.repeat(40) });
    try {
      const response = await post(handoffBody(currentBranch)).expect(409);
      refusal(response, 'fleet.flows.handoffHeadMoved.409');
      expect(await flowsOn(currentBranch)).toBe(0);
    } finally { gitlab.restore(); }
  });
});
