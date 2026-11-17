import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FleetPrRulingsService, NAX_ITEM_INDEX_MARKER } from './fleet-pr-rulings.service';
import { PrismaFleetPrRulingRepository } from './prisma-fleet-pr-ruling.repository';
import type { IFleetPrRulingRepository, RulingJobTarget } from './fleet-pr-ruling.domain';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import { PrRulingTools } from '../assistant/tools/pr-ruling-tools';
import type { AssistantToolRegistry } from '../assistant/assistant-tool.registry';
import type { AssistantTool, ToolContext } from '../assistant/assistant-tool.types';
import { ToolActionError, ToolInputError } from '../assistant/assistant-tool.types';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import type { IGitLabCredentialRepository } from '../git-broker/prisma-gitlab-credential.repository';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { encryptToken } from '../../common/utils/encryption.util';

const agent: AgentPrincipal = { actorType: 'agent', id: 'agent', slug: 'ruler', status: 'ACTIVE', capabilities: [] };

/** US-005: the key the GitLab credential store decrypts under; 32 bytes of hex, as the env holds it. */
const GITLAB_KEY = 'a'.repeat(64);
/** US-005: the two tokens differ, so the access a read passes proves which token kind was resolved. */
const GITLAB_READ_TOKEN = 'gitlab-read-token';
const GITLAB_WRITE_TOKEN = 'gitlab-write-token';
/** US-005: the stored credential of the GitLab repo under test, or none at all. */
const gitlabCredentialRow = () => ({
  repoId: 'r1', gitlabProjectId: 4711,
  encryptedReadToken: encryptToken(GITLAB_READ_TOKEN, GITLAB_KEY), encryptedWriteToken: encryptToken(GITLAB_WRITE_TOKEN, GITLAB_KEY),
  readTokenUserId: 1, readTokenUsername: 'reader', writeTokenUserId: 2, writeTokenUsername: 'writer', writeTokenIsBot: true,
  readTokenExpiresAt: null, writeTokenExpiresAt: null, readTokenInvalidAt: null, writeTokenInvalidAt: null,
});
/** US-005: the access a GitLab notes read presents: the read token and the repo's own host and project id. */
const gitlabAccess = { token: GITLAB_READ_TOKEN, target: { apiBase: 'https://gitlab.example.com/api/v4', projectId: 4711 } };

function setup(options: { credentialRow?: ReturnType<typeof gitlabCredentialRow> | null } = {}) {
  const repo: IFleetPrRulingRepository = {
    findTarget: vi.fn(), lockTarget: vi.fn(async () => null), latestRunForPr: vi.fn(async () => 'run'),
    latestRuling: vi.fn(async () => null), list: vi.fn(), pendingForFix: vi.fn(async () => []), replaceOlderRuns: vi.fn(),
    runsForPr: vi.fn(async () => []), settlePending: vi.fn(), replacePending: vi.fn(), insert: vi.fn(),
  };
  const github = { mintThreadReadToken: vi.fn(async () => ({ token: 'ephemeral', expiresAt: new Date() })), listIssueComments: vi.fn() };
  // US-005: the production credential store over an in-memory row, so `call` and its invalid mark are real.
  const markInvalid = vi.fn(async () => undefined);
  const credentialRow = 'credentialRow' in options ? options.credentialRow : gitlabCredentialRow();
  const credentials = new GitLabRepoCredentials(
    { findByRepoId: vi.fn(async () => credentialRow), markInvalid, upsert: vi.fn() } as unknown as IGitLabCredentialRepository,
    { encryptionKey: GITLAB_KEY },
  );
  const gitlab = { listMergeRequestNotes: vi.fn(async () => [] as string[]) };
  const service = new FleetPrRulingsService(repo, { run: (fn: () => Promise<unknown>) => fn() } as never, {} as never, {} as never, github as never, {} as never,
    credentials, gitlab as never);
  return { repo, github, service, credentials, gitlab, markInvalid };
}

const target = (over: Partial<RulingJobTarget> = {}): RulingJobTarget => ({
  projectId: 'project', repoId: 'repo', prNumber: 42, openItems: [{ id: 'D-1', kind: 'review' }],
  repo: { id: 'repo', provider: 'github', owner: 'acme', name: 'app', githubInstallationId: 77n }, ...over,
});
const draft = (openItems: { id: string; kind: string }[]) => ({ ...target({ openItems }), command: 'RUN', outcome: 'draft' });
/** US-005: a ruling target on a GitLab merge request, with the repo projection the repository supplies. */
const gitlabTarget = (over: Partial<RulingJobTarget> = {}): RulingJobTarget => target({
  prNumber: 12,
  repo: { id: 'r1', provider: 'gitlab', host: 'https://gitlab.example.com', owner: 'acme', name: 'app', githubInstallationId: null },
  ...over,
});

describe('ruling preflight', () => {
  it('AC-1: ruleTarget refuses a ci item before any forge read', async () => {
    const { service, repo, github } = setup();
    vi.mocked(repo.findTarget).mockResolvedValue(draft([{ id: 'C-1', kind: 'ci' }, { id: 'D-1', kind: 'finding' }]));
    await expect(service.ruleTarget('project', 'run', { itemId: 'C-1', text: 'confirm: green' }))
      .rejects.toMatchObject({ prefix: 'fleet.rulings.notRulable' });
    expect(github.mintThreadReadToken).not.toHaveBeenCalled();
  });

  it('AC-1: ruleTarget still accepts a finding on the same job', async () => {
    const { service, repo } = setup();
    vi.mocked(repo.findTarget).mockResolvedValue(draft([{ id: 'C-1', kind: 'ci' }, { id: 'D-1', kind: 'finding' }]));
    await expect(service.ruleTarget('project', 'run', { itemId: 'D-1', text: 'confirm: green' })).resolves.toMatchObject({ prNumber: 42 });
  });

  it('AC-2: assertItemIndex resolves when a comment carries the nax w-index marker', async () => {
    const { service, github } = setup();
    expect(NAX_ITEM_INDEX_MARKER).toBe('<!-- nax-bot:v1 key=w-index -->');
    github.listIssueComments.mockResolvedValue(['Ready for review', 'published nax items\n<!-- nax-bot:v1 key=w-index -->']);
    await expect(service.assertItemIndex(target())).resolves.toBeUndefined();
    expect(github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(77n, 'app');
    expect(github.listIssueComments).toHaveBeenCalledExactlyOnceWith('ephemeral', 'acme', 'app', 42);
  });

  it('AC-3: assertItemIndex refuses a short page with no marker', async () => {
    const { service, github } = setup();
    github.listIssueComments.mockResolvedValue(['Looks good', 'nit: naming', 'LGTM']);
    await expect(service.assertItemIndex(target())).rejects.toMatchObject({ prefix: 'fleet.rulings.noItemIndex' });
  });

  it('AC-4: assertItemIndex fails open when the comment read throws', async () => {
    const { service, github } = setup();
    github.listIssueComments.mockRejectedValue(new Error('provider_unreachable'));
    await expect(service.assertItemIndex(target())).resolves.toBeUndefined();
  });

  it('AC-4: assertItemIndex fails open when the token mint throws', async () => {
    const { service, github } = setup();
    github.mintThreadReadToken.mockRejectedValue(new Error('app_not_installed'));
    await expect(service.assertItemIndex(target())).resolves.toBeUndefined();
    expect(github.listIssueComments).not.toHaveBeenCalled();
  });

  it('AC-5: assertItemIndex fails open on a full page with no marker', async () => {
    const { service, github } = setup();
    github.listIssueComments.mockResolvedValue(Array.from({ length: 100 }, (_, i) => `comment ${i}`));
    await expect(service.assertItemIndex(target())).resolves.toBeUndefined();
  });

  it('AC-6: assertItemIndex reads nothing when the repo has no installation id', async () => {
    const { service, github } = setup();
    await expect(service.assertItemIndex(target({ repo: { id: 'repo', provider: 'github', owner: 'acme', name: 'app', githubInstallationId: null } }))).resolves.toBeUndefined();
    expect(github.mintThreadReadToken).not.toHaveBeenCalled();
  });

  it('AC-6: assertItemIndex fails open for a GitLab repo without a credential row and reads no GitHub method', async () => {
    const { service, github, credentials, gitlab } = setup({ credentialRow: null });
    const call = vi.spyOn(credentials, 'call');
    try {
      await expect(service.assertItemIndex(gitlabTarget())).resolves.toBeUndefined();
      expect(github.mintThreadReadToken).not.toHaveBeenCalled();
      expect(github.listIssueComments).not.toHaveBeenCalled();
      expect(gitlab.listMergeRequestNotes).not.toHaveBeenCalled();
      expect(call.mock.calls.map((args) => args[1])).toEqual(['read']);
    } finally { call.mockRestore(); }
  });

  it('AC-10: preflight reads the GitLab MR notes with { id, host } and the read token', async () => {
    const { service, repo, github, credentials, gitlab } = setup();
    vi.mocked(repo.findTarget).mockResolvedValue({ ...gitlabTarget(), command: 'RUN', outcome: 'draft' });
    gitlab.listMergeRequestNotes.mockResolvedValue([`published\n${NAX_ITEM_INDEX_MARKER}`]);
    const call = vi.spyOn(credentials, 'call');
    try {
      await expect(service.preflight('project', 'run', { itemId: 'D-1', text: 'confirm: green' })).resolves.toBeUndefined();
      expect(call).toHaveBeenCalledOnce();
      // The store addresses the repo by its id and its own host, and always asks for the read token.
      const [{ id, host }, kind] = call.mock.calls[0];
      expect({ id, host }).toEqual({ id: 'r1', host: 'https://gitlab.example.com' });
      expect(kind).toBe('read');
      expect(gitlab.listMergeRequestNotes).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
      expect(github.mintThreadReadToken).not.toHaveBeenCalled();
      expect(github.listIssueComments).not.toHaveBeenCalled();
    } finally { call.mockRestore(); }
  });

  it('AC-11: a short page of GitLab notes with no index marker is refused', async () => {
    const { service, gitlab } = setup();
    gitlab.listMergeRequestNotes.mockResolvedValue(['Looks good', 'nit: naming', 'LGTM']);
    await expect(service.assertItemIndex(gitlabTarget())).rejects.toMatchObject({ prefix: 'fleet.rulings.noItemIndex' });
  });

  it('AC-12: one GitLab note with the marker resolves the check', async () => {
    const { service, gitlab } = setup();
    gitlab.listMergeRequestNotes.mockResolvedValue(['Ready for review', `published nax items\n${NAX_ITEM_INDEX_MARKER}`]);
    await expect(service.assertItemIndex(gitlabTarget())).resolves.toBeUndefined();
    expect(gitlab.listMergeRequestNotes).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
  });

  it('AC-12: a full page of GitLab notes with no marker fails open', async () => {
    const { service, gitlab } = setup();
    gitlab.listMergeRequestNotes.mockResolvedValue(Array.from({ length: 100 }, (_, i) => `note ${i}`));
    await expect(service.assertItemIndex(gitlabTarget())).resolves.toBeUndefined();
    expect(gitlab.listMergeRequestNotes).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
  });

  it('AC-13: a repo with no credential row fails open', async () => {
    const { service, credentials, gitlab } = setup({ credentialRow: null });
    const call = vi.spyOn(credentials, 'call');
    try {
      await expect(service.assertItemIndex(gitlabTarget())).resolves.toBeUndefined();
      expect(call.mock.calls.map((args) => args[1])).toEqual(['read']);
      expect(gitlab.listMergeRequestNotes).not.toHaveBeenCalled();
    } finally { call.mockRestore(); }
  });

  it('AC-13: a thrown notes read fails open', async () => {
    const { service, gitlab } = setup();
    gitlab.listMergeRequestNotes.mockRejectedValue(new RepoCheckException('provider_error'));
    await expect(service.assertItemIndex(gitlabTarget())).resolves.toBeUndefined();
    expect(gitlab.listMergeRequestNotes).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
  });

  it('AC-14: a GitHub target reads issue comments through a minted thread-read token and never the GitLab store', async () => {
    const { service, github, credentials, gitlab } = setup();
    github.listIssueComments.mockResolvedValue([`published\n${NAX_ITEM_INDEX_MARKER}`]);
    const call = vi.spyOn(credentials, 'call');
    try {
      await expect(service.assertItemIndex(target())).resolves.toBeUndefined();
      expect(github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(77n, 'app');
      expect(github.listIssueComments).toHaveBeenCalledExactlyOnceWith('ephemeral', 'acme', 'app', 42);
      expect(call).not.toHaveBeenCalled();
      expect(gitlab.listMergeRequestNotes).not.toHaveBeenCalled();
    } finally { call.mockRestore(); }
  });

  it('AC-15: a 401 notes read marks the read token invalid before the check fails open', async () => {
    const { service, gitlab, markInvalid } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    markInvalid.mockImplementation(async () => { await gate; });
    // The checker turns a 401 into this refusal; `call` is what marks the token invalid.
    gitlab.listMergeRequestNotes.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));
    let settled = false;
    const answer = service.assertItemIndex(gitlabTarget()).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(markInvalid).toHaveBeenCalledExactlyOnceWith('r1', 'read', expect.any(Date));
    expect(settled).toBe(false);
    release();
    await expect(answer).resolves.toBeUndefined();
  });

  it('preflight runs ruleTarget then the item-index check', async () => {
    const { service, repo, github } = setup();
    vi.mocked(repo.findTarget).mockResolvedValue(draft([{ id: 'D-1', kind: 'finding' }]));
    github.listIssueComments.mockResolvedValue([]);
    await expect(service.preflight('project', 'run', { itemId: 'D-1', text: 'confirm: green' }))
      .rejects.toMatchObject({ prefix: 'fleet.rulings.noItemIndex' });
    expect(repo.findTarget).toHaveBeenCalledExactlyOnceWith('project', 'run');
  });

  it('preflight does not reach the forge when ruleTarget refuses', async () => {
    const { service, repo, github } = setup();
    vi.mocked(repo.findTarget).mockResolvedValue(draft([{ id: 'C-1', kind: 'ci' }]));
    await expect(service.preflight('project', 'run', { itemId: 'C-1', text: 'confirm: green' }))
      .rejects.toMatchObject({ prefix: 'fleet.rulings.notRulable' });
    expect(github.listIssueComments).not.toHaveBeenCalled();
  });
});

describe('assistant ruling tool preflight', () => {
  const registered = () => {
    const registry = { register: vi.fn() } as unknown as AssistantToolRegistry;
    const rulings = { preflight: vi.fn(), create: vi.fn() };
    new PrRulingTools(registry, rulings as never).onModuleInit();
    const [, write] = vi.mocked(registry.register).mock.calls[0] as [AssistantTool, AssistantTool<{ jobId: string; itemId: string; text: string }>];
    return { rulings, write };
  };
  const ctx: ToolContext = {
    projectId: 'project', projectSlug: 'web', actor: agent, threadId: null, jobId: null, now: new Date(),
    data: (text: string) => text, can: async () => true,
  };
  const input = { jobId: 'run', itemId: 'D-1', text: 'confirm: green' };

  it('AC-8: execute refuses fleet.rulings.noItemIndex and creates no ruling', async () => {
    const { rulings, write } = registered();
    const refusal = new ConflictAppException({}, 'fleet.rulings.noItemIndex');
    rulings.preflight.mockRejectedValue(refusal);
    await expect(write.execute(ctx, input)).rejects.toMatchObject({ text: 'pull request has no nax item index' });
    await expect(vi.mocked(rulings.preflight).mock.results[0].value).rejects.toMatchObject({ prefix: 'fleet.rulings.noItemIndex' });
    expect(rulings.preflight).toHaveBeenCalledExactlyOnceWith('project', 'run', { itemId: 'D-1', text: 'confirm: green' });
    expect(rulings.create).not.toHaveBeenCalled();
  });

  it('AC-8: preview refuses fleet.rulings.noItemIndex without proposing the write', async () => {
    const { rulings, write } = registered();
    rulings.preflight.mockRejectedValue(new ConflictAppException({}, 'fleet.rulings.noItemIndex'));
    await expect(write.preview?.(ctx, input)).rejects.toBeInstanceOf(ToolInputError);
    await expect(write.preview?.(ctx, input)).rejects.toMatchObject({ reason: 'pull request has no nax item index' });
    expect(rulings.create).not.toHaveBeenCalled();
  });

  it('maps the notRulable refusal for both preview and execute', async () => {
    const { rulings, write } = registered();
    rulings.preflight.mockRejectedValue(new ConflictAppException({}, 'fleet.rulings.notRulable'));
    await expect(write.preview?.(ctx, input)).rejects.toMatchObject({ reason: 'CI items cannot be ruled' });
    await expect(write.execute(ctx, input)).rejects.toBeInstanceOf(ToolActionError);
    expect(rulings.create).not.toHaveBeenCalled();
  });

  it('still creates when preflight passes', async () => {
    const { rulings, write } = registered();
    rulings.preflight.mockResolvedValue(undefined);
    rulings.create.mockResolvedValue({ id: 'ruling', state: 'pending' });
    await expect(write.execute(ctx, input)).resolves.toBe('ruling ruling: pending');
    expect(rulings.preflight).toHaveBeenCalledOnce();
    expect(rulings.create).toHaveBeenCalledOnce();
  });

  it('F1: prepare runs the preflight and returns a create-only mutation', async () => {
    const { rulings, write } = registered();
    rulings.preflight.mockResolvedValue(undefined);
    rulings.create.mockResolvedValue({ id: 'ruling', state: 'pending' });
    expect(write.prepare).toBeTypeOf('function');
    const mutate = await write.prepare?.(ctx, input);
    expect(rulings.preflight).toHaveBeenCalledExactlyOnceWith('project', 'run', { itemId: 'D-1', text: 'confirm: green' });
    expect(rulings.create).not.toHaveBeenCalled();
    await expect(mutate?.()).resolves.toBe('ruling ruling: pending');
    expect(rulings.create).toHaveBeenCalledExactlyOnceWith(agent, 'web', 'run', { itemId: 'D-1', text: 'confirm: green' });
    // One forge read per ruling: deferred execution must not repeat it under the approval transaction.
    expect(rulings.preflight).toHaveBeenCalledOnce();
  });

  it('F1: prepare maps a preflight refusal and creates nothing', async () => {
    const { rulings, write } = registered();
    rulings.preflight.mockRejectedValue(new ConflictAppException({}, 'fleet.rulings.noItemIndex'));
    await expect(write.prepare?.(ctx, input)).rejects.toMatchObject({ text: 'pull request has no nax item index' });
    expect(rulings.create).not.toHaveBeenCalled();
  });
});

describe('ruling target repo projection', () => {
  const jobRow = {
    id: 'run', projectId: 'project', repoId: 'repo', command: 'RUN', resultPrUrl: 'https://github.com/acme/app/pull/42',
    workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
    project: { id: 'project', slug: 'slug', deletedAt: null },
    repo: { id: 'repo', projectId: 'project', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: 77n },
  };
  const repository = (row: typeof jobRow = jobRow) => {
    const client = {
      fleetJob: { findFirst: vi.fn(async () => row), findUnique: vi.fn(async () => row) },
      $queryRaw: vi.fn(async () => []),
    };
    return new PrismaFleetPrRulingRepository({} as never, { client } as never);
  };
  const expected = { provider: 'github', owner: 'acme', name: 'app', githubInstallationId: 77n };

  it('AC-7: findTarget returns the job repo', async () => {
    expect(await repository().findTarget('project', 'run')).toMatchObject({ repo: expected });
  });

  it('AC-7: lockTarget returns the job repo', async () => {
    expect(await repository().lockTarget('slug', 'run')).toMatchObject({ repo: expected });
  });

  // F1: only `provider === 'gitlab'` selects the merge-request parser; any other stored value is a GitHub repo.
  it('F1: a repo with an unsupported provider takes the GitHub PR path', async () => {
    const row = { ...jobRow, repo: { ...jobRow.repo, provider: 'bitbucket', host: 'https://bitbucket.org' } };
    const repo = repository(row);
    expect(await repo.findTarget('project', 'run')).toMatchObject({ prNumber: 42 });
    expect(await repo.lockTarget('slug', 'run')).toMatchObject({ prNumber: 42 });
  });
});

describe('ruling refusal i18n', () => {
  const fleet = (locale: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'i18n', locale, 'fleet.json'), 'utf8'));

  it.each(['en', 'zh'])('AC-14: %s carries both new refusal codes', (locale) => {
    expect(fleet(locale).rulings).toMatchObject({
      notRulable: { 409: expect.stringMatching(/\S/) },
      noItemIndex: { 409: expect.stringMatching(/\S/) },
    });
  });

  it.each(['en', 'zh'])('US-005: %s carries the already-ruled refusal code', (locale) => {
    expect(fleet(locale).rulings).toMatchObject({ alreadyRuled: { 409: expect.stringMatching(/\S/) } });
  });

  // GitLab parity US-005: a GitLab merge request is a ruling target, so neither refusal names only GitHub.
  it.each([
    ['en', 'Only draft RUN jobs with a pull or merge request can be ruled', 'The job must identify a pull or merge request'],
    ['zh', '只能裁定具有拉取请求或合并请求的草稿 RUN 作业', '任务必须指定拉取请求或合并请求'],
  ])('US-005: %s drops GitHub from the draft and PR refusals', (locale, notDraft, invalidPr) => {
    const { rulings } = fleet(locale);
    expect({ notDraft: rulings.notDraft[409], invalidPr: rulings.invalidPr[400] }).toEqual({ notDraft, invalidPr });
    expect(JSON.stringify(rulings.notDraft) + JSON.stringify(rulings.invalidPr)).not.toContain('GitHub');
  });
});
