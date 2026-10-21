import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import type { FleetJobDto } from '../../jobs/dto/fleet-job.dto';
import { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeRepoRef } from '../../knowledge/knowledge-index.domain';
import { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_CANCEL_JOB } from '../koda-tool-descriptors';
import { cancelJobTool, type CancelJobInput } from './cancel-job-tool';

/**
 * Fleet S5b 2b2 US-005: `koda_cancel_job`'s parser, its masked preview and the cancel it runs on approval. The
 * tool is pure over its two collaborators here — the DB-backed path (route, propose, approve, the job really
 * cancelled) is `test/integration/fleet/assistant-cancel-job-tool.integration.spec.ts`.
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

/** The project's one repository, as `KnowledgeIndexService.resolveProjectRepo` would answer it (2b2-D4). */
const REPO: KnowledgeRepoRef = {
  id: 'r1',
  projectId: 'p-web',
  provider: 'github',
  owner: 'acme',
  name: 'app',
  defaultBranch: 'trunk',
  githubInstallationId: null,
};

/** The job `FleetJobsService.get` answers: a RUNNING RUN on the project's repository (2b2-D5). */
const JOB = {
  id: 'j1', projectId: 'p-web', repoId: 'r1', ref: 'trunk', command: 'RUN', feature: 'add-auth',
  maxCostUsd: '0.5', state: 'RUNNING',
} as unknown as FleetJobDto;

/** The token AC-13 hides: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

interface HarnessOptions {
  /** The job `get` answers, or the error it throws instead. */
  job?: FleetJobDto | Error;
  /** What `resolveProjectRepo` answers; `null` is a repository that no longer resolves (2b2-D4). */
  repo?: KnowledgeRepoRef | null;
  /** The error `cancel` throws instead of answering. */
  fails?: unknown;
  /** The job `cancel` answers. */
  answer?: FleetJobDto;
}

/** The tool over its two collaborators, with every call spied. */
function harness(options: HarnessOptions = {}) {
  const get = vi.fn(async () => {
    if (options.job instanceof Error) throw options.job;
    return options.job ?? JOB;
  });
  const cancel = vi.fn(async () => {
    if (options.fails !== undefined) throw options.fails;
    return options.answer ?? ({ id: 'j1', state: 'CANCELLED' } as unknown as FleetJobDto);
  });
  const resolveProjectRepo = vi.fn(async () => (options.repo === undefined ? REPO : options.repo));
  const tool = cancelJobTool(
    { get, cancel } as unknown as FleetJobsService,
    { resolveProjectRepo } as unknown as KnowledgeIndexService,
  );
  return { get, cancel, resolveProjectRepo, tool };
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
function previewOf(tool: AssistantTool<CancelJobInput>, input: CancelJobInput): Promise<string> {
  const preview = tool.preview;
  if (!preview) throw new Error('koda_cancel_job declares no preview');
  return preview(ctx, input);
}

/** The preview's refusal reason; the preview throws rather than answering. */
async function previewReasonOf(tool: AssistantTool<CancelJobInput>, input: CancelJobInput): Promise<string> {
  const failure = await failureOf(() => previewOf(tool, input));
  expect(failure).toBeInstanceOf(ToolInputError);
  return (failure as ToolInputError).reason;
}

describe('koda_cancel_job parse (US-005)', () => {
  it('AC-1: an empty jobId refuses with reason jobId', () => {
    expect(reasonOf(() => harness().tool.parse({ jobId: '' }))).toBe('jobId');
  });

  it('keeps the job id as written', () => {
    const tool = harness().tool;

    expect(tool.parse({ jobId: 'j1' })).toEqual({ jobId: 'j1' });
    expect(tool.parse({ jobId: 'x'.repeat(64) }).jobId).toBe('x'.repeat(64));
  });

  it('refuses a jobId that is missing, not a string, empty or over 64 characters (2b2-D3)', () => {
    const tool = harness().tool;

    expect(reasonOf(() => tool.parse({}))).toBe('jobId');
    expect(reasonOf(() => tool.parse({ jobId: undefined }))).toBe('jobId');
    expect(reasonOf(() => tool.parse({ jobId: null }))).toBe('jobId');
    expect(reasonOf(() => tool.parse({ jobId: 7 }))).toBe('jobId');
    expect(reasonOf(() => tool.parse({ jobId: 'x'.repeat(65) }))).toBe('jobId');
    expect(reasonOf(() => tool.parse(null))).toBe('jobId');
  });

  it('is a write tool that needs update FleetJob', () => {
    const tool = harness().tool;

    expect(tool.descriptor).toBe(KODA_CANCEL_JOB);
    expect(tool.kind).toBe('write');
    expect(tool.key).toBe('fleet.job.cancel');
  });
});

describe('koda_cancel_job preview (US-005)', () => {
  it('AC-2: a RUNNING job on a resolved repository answers the masked two-line proposal', async () => {
    const { tool } = harness();

    expect(await previewOf(tool, tool.parse({ jobId: 'j1' }))).toBe(
      'Cancel job j1 in web:\n' +
      'RUN add-auth on acme/app @ trunk, now RUNNING',
    );
  });

  it('AC-3: a terminal job refuses with reason state', async () => {
    const { tool } = harness({ job: { ...JOB, state: 'CANCELLED' } as FleetJobDto });

    expect(await previewReasonOf(tool, tool.parse({ jobId: 'j1' }))).toBe('state');
  });

  it('AC-4: a RUNNING THREAD job refuses with reason command (2b2-R5)', async () => {
    const { tool } = harness({ job: { ...JOB, command: 'THREAD', state: 'RUNNING' } as FleetJobDto });

    expect(await previewReasonOf(tool, tool.parse({ jobId: 'j1' }))).toBe('command');
  });

  it('#299: the state and command refusals say why', async () => {
    const ended = harness({ job: { ...JOB, state: 'CANCELLED' } as FleetJobDto }).tool;
    const thread = harness({ job: { ...JOB, command: 'THREAD', state: 'RUNNING' } as FleetJobDto }).tool;

    expect(((await failureOf(() => previewOf(ended, ended.parse({ jobId: 'j1' })))) as ToolInputError).detail)
      .toBe('the job is CANCELLED and has already ended');
    expect(((await failureOf(() => previewOf(thread, thread.parse({ jobId: 'j1' })))) as ToolInputError).detail)
      .toBe('a THREAD job cannot be cancelled with this tool');
  });

  it('AC-13: the preview is masked, so a token in the feature never appears', async () => {
    const { tool } = harness({ job: { ...JOB, feature: TOKEN } as FleetJobDto });

    const preview = await previewOf(tool, tool.parse({ jobId: 'j1' }));

    expect(preview).not.toContain(TOKEN);
    // The field is masked in place, not dropped: the user still reads the job line the feature belongs to.
    expect(preview).toBe(
      'Cancel job j1 in web:\n' +
      'RUN [masked] on acme/app @ trunk, now RUNNING',
    );
  });

  it('reads the job through FleetJobsService.get with the context project', async () => {
    const { get, tool } = harness();

    await previewOf(tool, tool.parse({ jobId: 'j1' }));

    expect(get.mock.calls).toEqual([['p-web', 'j1']]);
  });

  it('resolves the job\'s own repository by repoId, not by owner/name', async () => {
    const { resolveProjectRepo, tool } = harness();

    await previewOf(tool, tool.parse({ jobId: 'j1' }));

    expect(resolveProjectRepo.mock.calls).toEqual([['p-web', { repoId: 'r1' }]]);
  });

  it('refuses the five terminal states, not only CANCELLED (2b2-D5)', async () => {
    for (const state of ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']) {
      const { tool } = harness({ job: { ...JOB, state } as FleetJobDto });
      expect(await previewReasonOf(tool, tool.parse({ jobId: 'j1' })), state).toBe('state');
    }
    for (const state of ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']) {
      const { tool } = harness({ job: { ...JOB, state } as FleetJobDto });
      expect((await previewOf(tool, tool.parse({ jobId: 'j1' }))).split('\n')[1]).toBe(`RUN add-auth on acme/app @ trunk, now ${state}`);
    }
  });

  it('checks the command before the state, so a terminal THREAD job answers command too', async () => {
    const { tool } = harness({ job: { ...JOB, command: 'THREAD', state: 'CANCELLED' } as FleetJobDto });

    expect(await previewReasonOf(tool, tool.parse({ jobId: 'j1' }))).toBe('command');
  });

  it('previews a CONFIG_EDIT job the route cancels, naming its command (Out of Scope)', async () => {
    const { tool } = harness({ job: { ...JOB, command: 'CONFIG_EDIT', feature: 'deps-bump' } as FleetJobDto });

    expect(await previewOf(tool, tool.parse({ jobId: 'j1' }))).toBe(
      'Cancel job j1 in web:\n' +
      'CONFIG_EDIT deps-bump on acme/app @ trunk, now RUNNING',
    );
  });

  it('previews a CONFIG_DRIFT job the route cancels, naming its command (Out of Scope)', async () => {
    const { tool } = harness({ job: { ...JOB, command: 'CONFIG_DRIFT', feature: 'drift-check' } as FleetJobDto });

    expect(await previewOf(tool, tool.parse({ jobId: 'j1' }))).toBe(
      'Cancel job j1 in web:\n' +
      'CONFIG_DRIFT drift-check on acme/app @ trunk, now RUNNING',
    );
  });

  it('names a repository that no longer resolves by the job\'s own repoId (Out of Scope: no AC)', async () => {
    const { tool } = harness({ repo: null });

    const preview = await previewOf(tool, tool.parse({ jobId: 'j1' }));

    expect(preview.split('\n')[1]).toBe('RUN add-auth on r1 @ trunk, now RUNNING');
  });

  it('lets a refusal of the job read through untouched, so a foreign job still answers not_found', async () => {
    const notFound = new NotFoundAppException({}, 'fleet.jobs');
    const { tool } = harness({ job: notFound });

    expect(await failureOf(() => previewOf(tool, tool.parse({ jobId: 'j1' })))).toBe(notFound);
  });

  it('does not read the repository when the job cannot be cancelled', async () => {
    const { resolveProjectRepo, tool } = harness({ job: { ...JOB, state: 'CANCELLED' } as FleetJobDto });

    await failureOf(() => previewOf(tool, tool.parse({ jobId: 'j1' })));

    expect(resolveProjectRepo).not.toHaveBeenCalled();
  });
});

describe('koda_cancel_job execute (US-005)', () => {
  it('AC-5: cancels as the requester, in the context project, the job the input named, with canOperate true', async () => {
    const { cancel, tool } = harness();

    await tool.execute(ctx, tool.parse({ jobId: 'j1' }));

    expect(cancel.mock.calls).toEqual([['dev-1', 'p-web', 'j1', true]]);
  });

  it('AC-6: a job the service already cancelled answers the job and the path a human can open', async () => {
    const { tool } = harness({ answer: { id: 'j1', state: 'CANCELLED' } as unknown as FleetJobDto });

    expect(await tool.execute(ctx, tool.parse({ jobId: 'j1' }))).toBe('cancelled j1 /web/fleet/jobs/j1');
  });

  it('AC-7: a cancel the runner still has to acknowledge answers the requested state', async () => {
    const { tool } = harness({ answer: { id: 'j1', state: 'RUNNING' } as unknown as FleetJobDto });

    expect(await tool.execute(ctx, tool.parse({ jobId: 'j1' }))).toBe('cancel requested for j1 (RUNNING) /web/fleet/jobs/j1');
  });

  it('AC-8: a job the service refuses becomes the action\'s refusal text', async () => {
    const { tool } = harness({ fails: new ConflictAppException({ state: 'COMPLETED' }, 'fleet.jobState') });

    const failure = await failureOf(() => tool.execute(ctx, tool.parse({ jobId: 'j1' })));

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('cancel refused: job is COMPLETED');
  });

  it('rethrows a refusal the helper cannot name, so not-found still answers not_found', async () => {
    const notFound = new NotFoundAppException({}, 'fleet.jobs');
    const { tool } = harness({ fails: notFound });

    expect(await failureOf(() => tool.execute(ctx, tool.parse({ jobId: 'j1' })))).toBe(notFound);
  });

  it('rethrows anything that is not an AppException', async () => {
    const boom = new Error('connection reset');
    const { tool } = harness({ fails: boom });

    expect(await failureOf(() => tool.execute(ctx, tool.parse({ jobId: 'j1' })))).toBe(boom);
  });

  it('does not re-read the job: the service is the one authority at approval (2b2-D6)', async () => {
    const { get, tool } = harness();

    await tool.execute(ctx, tool.parse({ jobId: 'j1' }));

    expect(get).not.toHaveBeenCalled();
  });
});
