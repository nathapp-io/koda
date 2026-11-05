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

const agent: AgentPrincipal = { actorType: 'agent', id: 'agent', slug: 'ruler', status: 'ACTIVE', capabilities: [] };

function setup() {
  const repo: IFleetPrRulingRepository = {
    findTarget: vi.fn(), lockTarget: vi.fn(async () => null), latestRunForPr: vi.fn(async () => 'run'),
    latestRuling: vi.fn(async () => null), list: vi.fn(), pendingForFix: vi.fn(async () => []), replaceOlderRuns: vi.fn(),
    runsForPr: vi.fn(async () => []), settlePending: vi.fn(), replacePending: vi.fn(), insert: vi.fn(),
  };
  const github = { mintThreadReadToken: vi.fn(async () => ({ token: 'ephemeral', expiresAt: new Date() })), listIssueComments: vi.fn() };
  const service = new FleetPrRulingsService(repo, { run: (fn: () => Promise<unknown>) => fn() } as never, {} as never, {} as never, github as never);
  return { repo, github, service };
}

const target = (over: Partial<RulingJobTarget> = {}): RulingJobTarget => ({
  projectId: 'project', repoId: 'repo', prNumber: 42, openItems: [{ id: 'D-1', kind: 'review' }],
  repo: { provider: 'github', owner: 'acme', name: 'app', githubInstallationId: 77n }, ...over,
});
const draft = (openItems: { id: string; kind: string }[]) => ({ ...target({ openItems }), command: 'RUN', outcome: 'draft' });

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
    await expect(service.assertItemIndex(target({ repo: { provider: 'github', owner: 'acme', name: 'app', githubInstallationId: null } }))).resolves.toBeUndefined();
    expect(github.mintThreadReadToken).not.toHaveBeenCalled();
  });

  it('AC-6: assertItemIndex reads nothing for a GitLab repo', async () => {
    const { service, github } = setup();
    await expect(service.assertItemIndex(target({ repo: { provider: 'gitlab', owner: 'acme', name: 'app', githubInstallationId: 77n } }))).resolves.toBeUndefined();
    expect(github.mintThreadReadToken).not.toHaveBeenCalled();
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
  const repository = () => {
    const client = {
      fleetJob: { findFirst: vi.fn(async () => jobRow), findUnique: vi.fn(async () => jobRow) },
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
});

describe('ruling refusal i18n', () => {
  const fleet = (locale: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'i18n', locale, 'fleet.json'), 'utf8'));

  it.each(['en', 'zh'])('AC-14: %s carries both new refusal codes', (locale) => {
    expect(fleet(locale).rulings).toMatchObject({
      notRulable: { 409: expect.stringMatching(/\S/) },
      noItemIndex: { 409: expect.stringMatching(/\S/) },
    });
  });
});
