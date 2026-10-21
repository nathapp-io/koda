import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import type { DispatchResultDto } from '../../jobs/dto/fleet-job.dto';
import { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeRepoRef } from '../../knowledge/knowledge-index.domain';
import { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_DISPATCH_JOB } from '../koda-tool-descriptors';
import { dispatchJobTool, type DispatchJobInput } from './dispatch-job-tool';

/**
 * Fleet S5b 2b2 US-003: `koda_dispatch_job`'s parser, its masked preview and the dispatch it runs on approval. The
 * tool is pure over its two collaborators here — the DB-backed path (route, propose, approve, the job really
 * dispatched) is `test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts`.
 */

const ctx = {
  projectId: 'p-web',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test' },
  threadId: 'thread-1',
  jobId: 'job-thread',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data: (text: string) => text,
} as unknown as ToolContext;

/** The project's one repository, as `KnowledgeIndexService.resolveProjectRepo` would answer it (2b2-D5). */
const REPO: KnowledgeRepoRef = {
  id: 'r1',
  projectId: 'p-web',
  provider: 'github',
  owner: 'acme',
  name: 'app',
  defaultBranch: 'trunk',
  githubInstallationId: null,
};

/** The dispatch the service answers, as `DispatchResultDto.job` carries it. */
const RESULT = { job: { id: 'j1', state: 'QUEUED' }, placement: { assigned: false, runnerId: null, misfits: [] } } as unknown as DispatchResultDto;

/** The token AC-2 hides: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** The valid input every AC starts from; each test overrides the field it is about. */
const VALID = { repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5 } as const;

interface HarnessOptions {
  /** What `resolveProjectRepo` answers; `null` is the repository that does not resolve (2b2-D5). */
  repo?: KnowledgeRepoRef | null;
  /** The error the service throws instead of answering a dispatch. */
  fails?: unknown;
  /** The dispatch the service answers. */
  answer?: DispatchResultDto;
}

/** The tool over its two collaborators, with both calls spied. */
function harness(options: HarnessOptions = {}) {
  const resolveProjectRepo = vi.fn(async () => (options.repo === undefined ? REPO : options.repo));
  const dispatch = vi.fn(async () => {
    if (options.fails !== undefined) throw options.fails;
    return options.answer ?? RESULT;
  });
  const tool = dispatchJobTool(
    { dispatch } as unknown as FleetJobsService,
    { resolveProjectRepo } as unknown as KnowledgeIndexService,
  );
  return { dispatch, resolveProjectRepo, tool };
}

/** The `reason` a parser refuses with; fails loudly when it accepts or throws something else. */
function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).reason;
  }
  throw new Error('expected the parser to refuse this input');
}

/** The error a call throws; fails loudly when it answers instead. */
async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to refuse');
}

/** The tool's preview; fails loudly when a write tool declares none. */
function previewOf(tool: AssistantTool<DispatchJobInput>, input: DispatchJobInput): Promise<string> {
  const preview = tool.preview;
  if (!preview) throw new Error('koda_dispatch_job declares no preview');
  return preview(ctx, input);
}

describe('koda_dispatch_job parse (US-003)', () => {
  it('AC-1: an input without maxCostUsd refuses with reason maxCostUsd', () => {
    expect(reasonOf(() => harness().tool.parse({ repo: 'acme/app', command: 'RUN', feature: 'add-auth' }))).toBe('maxCostUsd');
  });

  it('AC-3: a repo that is not owner/name refuses with reason repo', () => {
    expect(reasonOf(() => harness().tool.parse({ ...VALID, repo: 'app' }))).toBe('repo');
  });

  it('keeps the fields as written and leaves the absent ones out', () => {
    const tool = harness().tool;

    expect(tool.parse(VALID)).toEqual({ repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5 });
    expect(tool.parse({
      ...VALID, ref: 'release', planFrom: 'docs/spec.md', profiles: ['native-ds', 'fast'],
      bashMode: 'escalate', ticketRefs: ['WEB-1', 'WEB-2'],
    })).toEqual({
      repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release',
      planFrom: 'docs/spec.md', profiles: ['native-ds', 'fast'], bashMode: 'escalate', ticketRefs: ['WEB-1', 'WEB-2'],
    });
  });

  it('refuses a repo that is missing, not a string or malformed', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, repo: undefined }))).toBe('repo');
    expect(reasonOf(() => tool.parse({ ...VALID, repo: 7 }))).toBe('repo');
    expect(reasonOf(() => tool.parse({ ...VALID, repo: 'acme/' }))).toBe('repo');
    expect(reasonOf(() => tool.parse({ ...VALID, repo: '/app' }))).toBe('repo');
    expect(reasonOf(() => tool.parse({ ...VALID, repo: 'acme/app/extra' }))).toBe('repo');
    expect(reasonOf(() => tool.parse(null))).toBe('repo');
  });

  it('refuses a command that is not RUN or PLAN', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, command: 'CONFIG_EDIT' }))).toBe('command');
    expect(reasonOf(() => tool.parse({ ...VALID, command: 'run' }))).toBe('command');
    expect(reasonOf(() => tool.parse({ ...VALID, command: undefined }))).toBe('command');
    expect(tool.parse({ ...VALID, command: 'PLAN' }).command).toBe('PLAN');
  });

  it('refuses a feature that is missing, empty, not a string or over 128 characters', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, feature: undefined }))).toBe('feature');
    expect(reasonOf(() => tool.parse({ ...VALID, feature: '' }))).toBe('feature');
    expect(reasonOf(() => tool.parse({ ...VALID, feature: 7 }))).toBe('feature');
    expect(reasonOf(() => tool.parse({ ...VALID, feature: 'x'.repeat(129) }))).toBe('feature');
    expect(tool.parse({ ...VALID, feature: 'x'.repeat(128) }).feature).toBe('x'.repeat(128));
  });

  it('refuses a cost that is missing, not a finite number or outside the dispatch bounds', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: undefined }))).toBe('maxCostUsd');
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: '0.5' }))).toBe('maxCostUsd');
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: Number.NaN }))).toBe('maxCostUsd');
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: Number.POSITIVE_INFINITY }))).toBe('maxCostUsd');
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: 0 }))).toBe('maxCostUsd');
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: 0.00009 }))).toBe('maxCostUsd');
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: 10_000.1 }))).toBe('maxCostUsd');
    // 2b2-D3: at most 4 decimal places, judged as Number(x.toFixed(4)) === x.
    expect(reasonOf(() => tool.parse({ ...VALID, maxCostUsd: 0.12345 }))).toBe('maxCostUsd');
    expect(tool.parse({ ...VALID, maxCostUsd: 0.0001 }).maxCostUsd).toBe(0.0001);
    expect(tool.parse({ ...VALID, maxCostUsd: 10_000 }).maxCostUsd).toBe(10_000);
    expect(tool.parse({ ...VALID, maxCostUsd: 0.1234 }).maxCostUsd).toBe(0.1234);
  });

  it('refuses an optional ref or planFrom outside its own bounds', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, ref: '' }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ...VALID, ref: 7 }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ...VALID, ref: 'x'.repeat(256) }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ...VALID, planFrom: '' }))).toBe('planFrom');
    expect(reasonOf(() => tool.parse({ ...VALID, planFrom: 'x'.repeat(513) }))).toBe('planFrom');
    expect(tool.parse({ ...VALID, ref: 'x'.repeat(255) }).ref).toBe('x'.repeat(255));
  });

  it('refuses profiles that are not 1 to 8 strings of 1 to 64 characters', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, profiles: 'fast' }))).toBe('profiles');
    expect(reasonOf(() => tool.parse({ ...VALID, profiles: [7] }))).toBe('profiles');
    expect(reasonOf(() => tool.parse({ ...VALID, profiles: [''] }))).toBe('profiles');
    expect(reasonOf(() => tool.parse({ ...VALID, profiles: ['x'.repeat(65)] }))).toBe('profiles');
    expect(reasonOf(() => tool.parse({ ...VALID, profiles: Array.from({ length: 9 }, (_, i) => `p${i}`) }))).toBe('profiles');
    expect(tool.parse({ ...VALID, profiles: [] }).profiles).toEqual([]);
  });

  it('refuses a bashMode that is not one of the three modes', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, bashMode: 'yolo' }))).toBe('bashMode');
    expect(reasonOf(() => tool.parse({ ...VALID, bashMode: 7 }))).toBe('bashMode');
    expect(tool.parse({ ...VALID, bashMode: 'gated' }).bashMode).toBe('gated');
  });

  it('refuses ticketRefs that are not 1 to 20 ticket refs', () => {
    const tool = harness().tool;
    expect(reasonOf(() => tool.parse({ ...VALID, ticketRefs: 'WEB-1' }))).toBe('ticketRefs');
    expect(reasonOf(() => tool.parse({ ...VALID, ticketRefs: [] }))).toBe('ticketRefs');
    expect(reasonOf(() => tool.parse({ ...VALID, ticketRefs: ['web-1'] }))).toBe('ticketRefs');
    expect(reasonOf(() => tool.parse({ ...VALID, ticketRefs: Array.from({ length: 21 }, (_, i) => `WEB-${i + 1}`) }))).toBe('ticketRefs');
    expect(tool.parse({ ...VALID, ticketRefs: ['WEB-1'] }).ticketRefs).toEqual(['WEB-1']);
  });

  it('is a write tool that needs create FleetJob', () => {
    const tool = harness().tool;
    expect(tool.descriptor).toBe(KODA_DISPATCH_JOB);
    expect(tool.kind).toBe('write');
    expect(tool.key).toBe('fleet.job.dispatch');
  });
});

describe('koda_dispatch_job preview (US-003)', () => {
  it('AC-2: a PLAN answers the masked six-line proposal, the default branch standing in for the ref', async () => {
    const { tool } = harness();

    const preview = await previewOf(tool, tool.parse({
      repo: 'acme/app', command: 'PLAN', feature: 'add-auth', maxCostUsd: 0.5,
      planFrom: `docs/${TOKEN}.md`,
    }));

    expect(preview).toBe(
      'Dispatch PLAN in web:\n' +
      'repo: acme/app @ trunk\n' +
      'feature: add-auth\n' +
      'max cost: $0.5\n' +
      'plan from: docs/[masked].md',
    );
  });

  it('AC-4: a RUN lists the ref, the profiles, the bash mode and the tickets in that order', async () => {
    const { tool } = harness();

    const preview = await previewOf(tool, tool.parse({
      repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release',
      profiles: ['native-ds', 'fast'], bashMode: 'escalate', ticketRefs: ['WEB-1', 'WEB-2'],
    }));

    expect(preview).toBe(
      'Dispatch RUN in web:\n' +
      'repo: acme/app @ release\n' +
      'feature: add-auth\n' +
      'max cost: $0.5\n' +
      'profiles: native-ds, fast\n' +
      'bash: escalate\n' +
      'tickets: WEB-1, WEB-2',
    );
  });

  it('AC-5: a repository that does not resolve is not found', async () => {
    const { resolveProjectRepo, tool } = harness({ repo: null });

    const failure = await failureOf(() => previewOf(tool, tool.parse({ ...VALID, repo: 'acme/ops' })));

    expect(failure).toBeInstanceOf(NotFoundAppException);
    expect(resolveProjectRepo).toHaveBeenCalledWith('p-web', { owner: 'acme', name: 'ops' });
  });

  it('AC-6: a PLAN without planFrom refuses with the reason normalizeDispatch gives', async () => {
    const { tool } = harness();

    const failure = await failureOf(() => previewOf(tool, tool.parse({ ...VALID, command: 'PLAN' })));

    expect(failure).toBeInstanceOf(ToolInputError);
    expect((failure as ToolInputError).reason).toBe('planFrom required for PLAN');
  });

  it('reads the project\'s repository by owner/name and never by id', async () => {
    const { resolveProjectRepo, tool } = harness();

    await previewOf(tool, tool.parse(VALID));

    expect(resolveProjectRepo.mock.calls).toEqual([['p-web', { owner: 'acme', name: 'app' }]]);
  });

  it('carries the other normalizeDispatch refusals through as ToolInputError reasons', async () => {
    const { tool } = harness();

    // nax' feature-name rule, applied by the service's own normalization (2b2-D3).
    const badFeature = await failureOf(() => previewOf(tool, tool.parse({ ...VALID, feature: '-add-auth' })));
    expect((badFeature as ToolInputError).reason).toBe('feature');

    // The RUN/PLAN split: a RUN never carries a plan path.
    const runWithPlan = await failureOf(() => previewOf(tool, tool.parse({ ...VALID, planFrom: 'docs/spec.md' })));
    expect(runWithPlan).toBeInstanceOf(ToolInputError);
    expect((runWithPlan as ToolInputError).reason).toBe('planFrom is only for PLAN');

    // The ref rule, which the parser only bounds by length.
    const badRef = await failureOf(() => previewOf(tool, tool.parse({ ...VALID, ref: 'release..1' })));
    expect((badRef as ToolInputError).reason).toBe('ref');
  });

  it('lets a refusal that is not a service validation through untouched', async () => {
    const resolveProjectRepo = vi.fn(async () => { throw new Error('database is down'); });
    const tool = dispatchJobTool(
      { dispatch: vi.fn() } as unknown as FleetJobsService,
      { resolveProjectRepo } as unknown as KnowledgeIndexService,
    );

    const failure = await failureOf(() => previewOf(tool, tool.parse(VALID)));

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('database is down');
  });

  it('masks a token in the feature and the profiles too', async () => {
    const { tool } = harness();

    const preview = await previewOf(tool, tool.parse({ ...VALID, feature: `add-auth-${TOKEN}`, profiles: [`p-${TOKEN}`] }));

    expect(preview).not.toContain(TOKEN);
    expect(preview).toContain('feature: add-auth-[masked]');
    expect(preview).toContain('profiles: p-[masked]');
  });
});

describe('koda_dispatch_job execute (US-003)', () => {
  it('AC-7: dispatches the resolved repo id and the input\'s own fields, and nothing else', async () => {
    const { dispatch, tool } = harness();

    await tool.execute(ctx, tool.parse({
      repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release',
      profiles: ['native-ds'], bashMode: 'escalate', ticketRefs: ['WEB-1'],
    }));

    const dto = dispatch.mock.calls[0]?.[2];
    expect(dto).toEqual({
      repoId: 'r1', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5, ref: 'release',
      profiles: ['native-ds'], bashMode: 'escalate', ticketRefs: ['WEB-1'],
    });
    // 2b2-R6: the fields the tool does not take are absent, so `normalizeDispatch` applies its own defaults.
    expect(Object.keys(dto as object).sort()).toEqual(['bashMode', 'command', 'feature', 'maxCostUsd', 'profiles', 'ref', 'repoId', 'ticketRefs']);
  });

  it('leaves every absent optional field out of the dispatch dto', async () => {
    const { dispatch, tool } = harness();

    await tool.execute(ctx, tool.parse(VALID));

    expect(dispatch.mock.calls[0]?.[2]).toEqual({ repoId: 'r1', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5 });
  });

  it('AC-8: dispatches as the requester, in the context project', async () => {
    const { dispatch, tool } = harness();

    await tool.execute(ctx, tool.parse(VALID));

    expect(dispatch.mock.calls[0]?.[0]).toBe(ctx.actor.id);
    expect(dispatch.mock.calls[0]?.[1]).toBe(ctx.projectId);
  });

  it('AC-9: hands the service the ticket actor and no thread, so the job is never bound to this thread', async () => {
    const { dispatch, tool } = harness();

    await tool.execute(ctx, tool.parse(VALID));

    const opts = dispatch.mock.calls[0]?.[3];
    expect(opts).toEqual({ ticketActor: { principal: ctx.actor, projectSlug: 'web' } });
    expect(Object.keys(opts as object)).toEqual(['ticketActor']);
  });

  it('AC-10: answers the job it dispatched and the path a human can open', async () => {
    const { tool } = harness();

    expect(await tool.execute(ctx, tool.parse(VALID))).toBe('dispatched j1: QUEUED /web/fleet/jobs/j1');
  });

  it('AC-11: a dispatch refused for an open PR becomes the action\'s refusal text', async () => {
    const { dispatch, tool } = harness({ fails: new ConflictAppException({ refs: 'WEB-1' }, 'fleet.dispatchOpenPr') });

    const failure = await failureOf(() => tool.execute(ctx, tool.parse({ ...VALID, ticketRefs: ['WEB-1'] })));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('dispatch refused: open PR on WEB-1');
  });

  it('a budget pause becomes the action\'s refusal text as well', async () => {
    const { tool } = harness({ fails: new ConflictAppException({ scope: 'project web' }, 'fleet.budgetPaused') });

    const failure = await failureOf(() => tool.execute(ctx, tool.parse(VALID)));

    expect((failure as ToolActionError).text).toBe('dispatch refused: budget paused for project web');
  });

  it('rethrows a refusal the helper cannot name, so not-found still answers not_found', async () => {
    const notFound = new NotFoundAppException({}, 'fleet.repos');
    const { tool } = harness({ fails: notFound });

    expect(await failureOf(() => tool.execute(ctx, tool.parse(VALID)))).toBe(notFound);
  });

  it('rethrows anything that is not an AppException', async () => {
    const boom = new Error('connection reset');
    const { tool } = harness({ fails: boom });

    expect(await failureOf(() => tool.execute(ctx, tool.parse(VALID)))).toBe(boom);
  });

  it('does not dispatch when the repository no longer resolves at approval (2b2-D6)', async () => {
    const { dispatch, tool } = harness({ repo: null });

    const failure = await failureOf(() => tool.execute(ctx, tool.parse({ ...VALID, repo: 'acme/gone' })));

    expect(failure).toBeInstanceOf(NotFoundAppException);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('resolves the repository for the execute as well as the preview', async () => {
    const { resolveProjectRepo, tool } = harness();

    await tool.execute(ctx, tool.parse(VALID));

    expect(resolveProjectRepo).toHaveBeenCalledWith('p-web', { owner: 'acme', name: 'app' });
  });

  it('names the service\'s own dispatch-input refusal, so the action quotes the field it refused', async () => {
    const { tool } = harness({ fails: new ValidationAppException({ reason: 'feature' }, 'fleet.dispatchInput') });

    const failure = await failureOf(() => tool.execute(ctx, tool.parse(VALID)));

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('dispatch refused: invalid feature');
  });

  it('lets a validation refusal of another module through untouched, so the executor answers error', async () => {
    const invalid = new ValidationAppException({ reason: 'x' }, 'tickets.update');
    const { tool } = harness({ fails: invalid });

    expect(await failureOf(() => tool.execute(ctx, tool.parse(VALID)))).toBe(invalid);
  });
});
