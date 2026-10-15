import { Test, type TestingModule } from '@nestjs/testing';
import { KODA_TOOL_LIMITS } from '@nathapp/fleet-protocol';
import { FleetJobState } from '../../../common/enums';
import { AnalyticsService } from '../../analytics/analytics.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { FleetJobsService } from '../../jobs/fleet-jobs.service';
import { LogReadService } from '../../logs/log-read.service';
import { FleetLogExpiredException } from '../../logs/log-read.exceptions';
import { RunnersService } from '../../runners/runners.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolInputError, type ToolContext } from '../assistant-tool.types';
import { KODA_TOOL_DESCRIPTORS } from '../koda-tool-descriptors';
import {
  FleetTools, fleetSpendTool, getJobTool, jobLogExcerptTool, listApprovalsTool, listJobsTool, runnerStatusTool,
} from './fleet-tools';

const TOOL_NAMES = [
  'koda_list_jobs', 'koda_get_job', 'koda_fleet_spend', 'koda_list_approvals', 'koda_runner_status', 'koda_job_log_excerpt',
] as const;

/** The parsers never touch a service, so the stubs only satisfy the DI graph. */
const stubJobs = {} as FleetJobsService;
const stubAnalytics = {} as AnalyticsService;
const stubApprovals = {} as ApprovalsService;
const stubRunners = {} as RunnersService;
const stubLogs = {} as LogReadService;

const isPlainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

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

const jobs = () => listJobsTool(stubJobs);
const getJob = () => getJobTool(stubJobs);
const spend = () => fleetSpendTool(stubAnalytics);
const approvals = () => listApprovalsTool(stubApprovals);
const runners = () => runnerStatusTool(stubRunners);
const logs = () => jobLogExcerptTool(stubLogs);

// The real registry, filled by FleetTools.onModuleInit through Nest's lifecycle.
describe('fleet read tools (US-004)', () => {
  let module: TestingModule;
  let registry: AssistantToolRegistry;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        FleetTools,
        AssistantToolRegistry,
        { provide: FleetJobsService, useValue: stubJobs },
        { provide: AnalyticsService, useValue: stubAnalytics },
        { provide: ApprovalsService, useValue: stubApprovals },
        { provide: RunnersService, useValue: stubRunners },
        { provide: LogReadService, useValue: stubLogs },
      ],
    }).compile();
    await module.init();
    registry = module.get(AssistantToolRegistry);
  });

  afterAll(async () => {
    await module.close();
  });

  it('AC-1: registers each fleet tool with its KODA_TOOL_DESCRIPTORS entry as its descriptor', () => {
    for (const name of TOOL_NAMES) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.descriptor).toBe(KODA_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name));
    }
  });

  it('AC-3: koda_job_log_excerpt parse with stream stdout and level error refuses with reason level', () => {
    expect(reasonOf(() => logs().parse({ jobId: 'j1', stream: 'stdout', level: 'error' }))).toBe('level');
  });

  it('AC-7: koda_fleet_spend parse with { days: 91 } refuses with reason days', () => {
    expect(reasonOf(() => spend().parse({ days: 91 }))).toBe('days');
  });

  it('AC-14: koda_job_log_excerpt parse with { jobId: "j1", limit: 51 } refuses with reason limit', () => {
    expect(reasonOf(() => logs().parse({ jobId: 'j1', limit: 51 }))).toBe('limit');
  });

  it('AC-15: every descriptor passes the runner limits', () => {
    expect(KODA_TOOL_DESCRIPTORS.length).toBeLessThanOrEqual(KODA_TOOL_LIMITS.maxTools);
    for (const descriptor of KODA_TOOL_DESCRIPTORS) {
      expect(descriptor.name).toMatch(KODA_TOOL_LIMITS.nameRe);
      expect(descriptor.description.length).toBeLessThanOrEqual(2000);
      expect(isPlainObject(descriptor.inputSchema)).toBe(true);
    }
    // The six US-004 tools are part of that catalog.
    expect(KODA_TOOL_DESCRIPTORS.map((d) => d.name)).toEqual(expect.arrayContaining([...TOOL_NAMES]));
  });

  it('every fleet tool declares project membership as its permission', () => {
    for (const name of TOOL_NAMES) expect(registry.get(name)?.permission).toEqual({ kind: 'member' });
  });

  it('koda_list_jobs parse keeps state and feature and defaults page to 1', () => {
    expect(jobs().parse({ state: 'FAILED', feature: 'nightly' })).toEqual({ state: 'FAILED', feature: 'nightly', page: 1 });
    expect(jobs().parse({})).toEqual({ state: undefined, feature: undefined, page: 1 });
    expect(jobs().parse({ page: 4 })).toMatchObject({ page: 4 });
    expect(jobs().parse({ state: FleetJobState.COMPLETED })).toMatchObject({ state: 'COMPLETED' });
  });

  it('koda_list_jobs parse refuses an unknown state, a bad page and an out-of-range feature', () => {
    expect(reasonOf(() => jobs().parse({ state: 'DONE' }))).toBe('state');
    expect(reasonOf(() => jobs().parse({ page: 0 }))).toBe('page');
    expect(reasonOf(() => jobs().parse({ page: 2.5 }))).toBe('page');
    expect(reasonOf(() => jobs().parse({ feature: '' }))).toBe('feature');
    expect(reasonOf(() => jobs().parse({ feature: 'x'.repeat(101) }))).toBe('feature');
  });

  it('koda_get_job parse takes a job id and refuses a missing one', () => {
    expect(getJob().parse({ jobId: 'job-1' })).toEqual({ jobId: 'job-1' });
    expect(reasonOf(() => getJob().parse({}))).toBe('jobId');
    expect(reasonOf(() => getJob().parse({ jobId: '' }))).toBe('jobId');
    expect(reasonOf(() => getJob().parse(null))).toBe('jobId');
  });

  it('koda_fleet_spend parse defaults to 7 days and accepts 1 and 90', () => {
    expect(spend().parse({})).toEqual({ days: 7 });
    expect(spend().parse({ days: 1 })).toEqual({ days: 1 });
    expect(spend().parse({ days: 90 })).toEqual({ days: 90 });
    expect(reasonOf(() => spend().parse({ days: 0 }))).toBe('days');
    expect(reasonOf(() => spend().parse({ days: 3.5 }))).toBe('days');
  });

  it('koda_list_approvals parse defaults to pending and refuses a status outside the enum', () => {
    expect(approvals().parse({})).toEqual({ status: 'pending', page: 1 });
    expect(approvals().parse({ status: 'approved', page: 3 })).toEqual({ status: 'approved', page: 3 });
    for (const status of ['expired', 'cancelled', 'rejected']) expect(approvals().parse({ status })).toMatchObject({ status });
    expect(reasonOf(() => approvals().parse({ status: 'open' }))).toBe('status');
    expect(reasonOf(() => approvals().parse({ page: 0 }))).toBe('page');
  });

  it('koda_runner_status parse takes no input', () => {
    expect(runners().parse({ anything: 'ignored' })).toEqual({});
    expect(runners().parse(undefined)).toEqual({});
  });

  it('koda_job_log_excerpt parse defaults to the run stream, 20 entries, and accepts every stream and level', () => {
    expect(logs().parse({ jobId: 'j1' })).toEqual({ jobId: 'j1', stream: 'run', level: undefined, query: undefined, limit: 20 });
    expect(logs().parse({ jobId: 'j1', stream: 'stdout' })).toMatchObject({ stream: 'stdout' });
    expect(logs().parse({ jobId: 'j1', stream: 'stderr' })).toMatchObject({ stream: 'stderr' });
    expect(logs().parse({ jobId: 'j1', stream: 'run', level: 'warn' })).toMatchObject({ level: 'warn' });
    expect(logs().parse({ jobId: 'j1', limit: 50, query: 'boom' })).toMatchObject({ limit: 50, query: 'boom' });
  });

  it('koda_job_log_excerpt parse refuses a bad stream, level, query, limit and a missing job id', () => {
    expect(reasonOf(() => logs().parse({ jobId: 'j1', stream: 'prompt' }))).toBe('stream');
    expect(reasonOf(() => logs().parse({ jobId: 'j1', stream: 'thread' }))).toBe('stream');
    expect(reasonOf(() => logs().parse({ jobId: 'j1', level: 'fatal' }))).toBe('level');
    expect(reasonOf(() => logs().parse({ jobId: 'j1', stream: 'stderr', level: 'info' }))).toBe('level');
    expect(reasonOf(() => logs().parse({ jobId: 'j1', query: '' }))).toBe('query');
    expect(reasonOf(() => logs().parse({ jobId: 'j1', query: 'x'.repeat(101) }))).toBe('query');
    expect(reasonOf(() => logs().parse({ jobId: 'j1', limit: 0 }))).toBe('limit');
    expect(reasonOf(() => logs().parse({}))).toBe('jobId');
  });
});

const FENCE_OPEN = /^<<koda-data-[0-9a-f]{16}>>$/;

/** The payloads of every `ctx.data(...)` fence in a result, in order. */
function fencedLines(content: string): string[] {
  const lines = content.split('\n');
  const values: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous !== undefined && current !== undefined && FENCE_OPEN.test(previous)) values.push(current);
  }
  return values;
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1' } as ToolContext['actor'],
  threadId: 'thread-1',
  jobId: 'thread-job-1',
  now: new Date('2026-10-15T00:00:00.000Z'),
  data: (text: string) => `<<koda-data-0000000000000000>>\n${text}\n<<end-koda-data-0000000000000000>>`,
  ...over,
});

/**
 * The tools' execute paths against mocked services: the project scope, the filters, the emitted fields and the
 * log header. The PG-backed integration spec covers the same behaviour against real rows.
 */
describe('fleet read tools execute (US-004)', () => {
  it('koda_list_jobs reads the thread project and answers id, path and the next page line', async () => {
    const list = vi.fn(async () => ({
      records: [
        { id: 'job-1', command: 'RUN', state: 'FAILED', feature: 'nightly', costSpentUsd: '1.2500', queuedAt: '2026-10-14T00:00:00.000Z' },
        { id: 'job-2', command: 'PLAN', state: 'FAILED', feature: 'review', costSpentUsd: '0.0000', queuedAt: '2026-10-13T00:00:00.000Z' },
      ],
      hasNext: true,
    }));
    const tool = listJobsTool({ list } as unknown as FleetJobsService);
    const content = await tool.execute(ctx(), tool.parse({ state: 'FAILED', page: 2 }));

    expect(list).toHaveBeenCalledWith({ projectId: 'project-1', state: 'FAILED' }, { current: 2, size: 20 });
    expect(content).toContain('job-1 RUN FAILED nightly 1.2500 2026-10-14T00:00:00.000Z /web/fleet/jobs/job-1');
    expect(content.split('\n').at(-1)).toBe('more: call koda_list_jobs with page 3');
  });

  it('koda_list_jobs answers no jobs on an empty page and no page line on the last page', async () => {
    const empty = listJobsTool({ list: vi.fn(async () => ({ records: [], hasNext: false })) } as unknown as FleetJobsService);
    expect(await empty.execute(ctx(), empty.parse({}))).toBe('no jobs');

    const full = listJobsTool({ list: vi.fn(async () => ({
      records: [{ id: 'job-1', command: 'RUN', state: 'FAILED', feature: 'f', costSpentUsd: '0.0000', queuedAt: '2026-10-14T00:00:00.000Z' }],
      hasNext: false,
    })) } as unknown as FleetJobsService);
    const content = await full.execute(ctx(), full.parse({}));
    expect(content).not.toContain('more: call');
    expect(content).toContain('/web/fleet/jobs/job-1');
  });

  it('koda_get_job scopes the id to the project and fences the three untrusted fields', async () => {
    const get = vi.fn(async () => ({
      id: 'job-9', command: 'RUN', state: 'ESCALATED', feature: 'nightly', ref: 'trunk',
      costSpentUsd: '1.2345', maxCostUsd: '5.0000', queuedAt: '2026-10-14T00:00:00.000Z', finishedAt: '2026-10-14T02:00:00.000Z',
      stateReason: 'tests failed', escalationReason: 'tests failed', resultPrUrl: 'https://github.com/acme/app/pull/7',
      stories: [{ id: 'US-001' }],
    }));
    const tool = getJobTool({ get } as unknown as FleetJobsService);
    const content = await tool.execute(ctx(), tool.parse({ jobId: 'job-9' }));

    expect(get).toHaveBeenCalledWith('project-1', 'job-9');
    expect(content).toContain('ESCALATED');
    expect(content).toContain('costSpentUsd: 1.2345');
    expect(content).toContain('/web/fleet/jobs/job-9');
    expect(fencedLines(content)).toEqual(['tests failed', 'tests failed', 'https://github.com/acme/app/pull/7']);
    // The story list is deliberately not emitted.
    expect(content).not.toContain('US-001');
  });

  it('koda_get_job prints (none) for the fields a job has no value for and lets a service error through', async () => {
    const get = vi.fn(async () => ({
      id: 'job-9', command: 'RUN', state: 'QUEUED', feature: 'f', ref: 'trunk', costSpentUsd: '0.0000', maxCostUsd: '1.0000',
      queuedAt: '2026-10-14T00:00:00.000Z', finishedAt: null, stateReason: null, escalationReason: null, resultPrUrl: null,
    }));
    const tool = getJobTool({ get } as unknown as FleetJobsService);
    const content = await tool.execute(ctx(), tool.parse({ jobId: 'job-9' }));
    expect(content).toContain('finishedAt: (none)');
    expect(fencedLines(content)).toEqual([]);

    const foreign = getJobTool({ get: vi.fn(async () => { throw new Error('NotFoundAppException'); }) } as unknown as FleetJobsService);
    await expect(foreign.execute(ctx(), { jobId: 'ops-job' })).rejects.toThrow('NotFoundAppException');
  });

  it('koda_fleet_spend asks for the window ending at ctx.now and reports the totals', async () => {
    const spendSpy = vi.fn(async () => ({
      window: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' },
      totals: { costUsd: '1.5000', tokens: 30, jobs: 2, medianJobCostUsd: '0.7500' },
    }));
    const tool = fleetSpendTool({ spend: spendSpy } as unknown as AnalyticsService);
    const content = await tool.execute(ctx(), tool.parse({ days: 7 }));

    expect(spendSpy).toHaveBeenCalledWith(
      'project-1',
      { from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' },
      ctx().now,
    );
    expect(content).toContain('totals.costUsd: 1.5000');
    expect(content).toContain('totals.jobs: 2');
    expect(content).toContain('totals.tokens: 30');
    expect(content).toContain('totals.medianJobCostUsd: 0.7500');
  });

  it('koda_list_approvals reads the project route with the executor role and reports the ids', async () => {
    const list = vi.fn(async () => ({
      records: [{ id: 'approval-1', type: 'nax_bash_escalate', status: 'pending', jobId: 'job-1', requestedAt: '2026-10-14T00:00:00.000Z' }],
      hasNext: true,
    }));
    const tool = listApprovalsTool({ list } as unknown as ApprovalsService);
    const content = await tool.execute(ctx({ actor: { id: 'dev-1', projectRole: 'DEVELOPER' } as ToolContext['actor'] }), tool.parse({}));

    expect(list).toHaveBeenCalledWith({ kind: 'project', projectId: 'project-1', role: 'DEVELOPER' }, { status: 'pending' }, { current: 1, size: 20 });
    expect(content).toContain('approval-1 nax_bash_escalate pending job-1 2026-10-14T00:00:00.000Z');
    expect(content.split('\n').at(-1)).toBe('more: call koda_list_approvals with page 2');
  });

  it('koda_runner_status reads the first 50 and fences the runner-supplied name and labels', async () => {
    const listSummaries = vi.fn(async () => ({
      records: [
        { name: 'box-a', labels: ['linux', 'gpu'], online: true, enabled: true, projectThreads: false },
        { name: 'box-b', labels: [], online: false, enabled: false, projectThreads: true },
      ],
      hasNext: false,
    }));
    const tool = runnerStatusTool({ listSummaries } as unknown as RunnersService);
    const content = await tool.execute(ctx(), {});

    expect(listSummaries).toHaveBeenCalledWith({ current: 1, size: 50 }, ctx().now);
    expect(content).toContain('- online: true enabled: true projectThreads: false');
    expect(content).toContain('- online: false enabled: false projectThreads: true');
    expect(fencedLines(content)).toEqual(['box-a', 'linux, gpu', 'box-b']);
    expect(content).toContain('labels: (none)');
  });

  it('koda_job_log_excerpt reads backward, prints the scan header and fences each entry text', async () => {
    const entries = vi.fn(async () => ({
      entries: [
        { offset: 0, length: 10, timestamp: '2026-10-04T08:00:00.000Z', level: 'info', message: 'one' },
        { offset: 10, length: 10, timestamp: '2026-10-04T08:00:01.000Z', level: 'error', message: 'two' },
      ],
      scannedFrom: 0, scannedTo: 40, truncated: false, complete: true,
    }));
    const tool = jobLogExcerptTool({ entries } as unknown as LogReadService);
    const content = await tool.execute(ctx(), tool.parse({ jobId: 'job-1', level: 'info', query: 'o' }));

    expect(entries).toHaveBeenCalledWith('project-1', 'job-1', 'run', { direction: 'backward', limit: 20, level: 'info', q: 'o' });
    expect(content.split('\n')[0]).toBe('stream run, scanned 40 bytes, truncated: false, complete: true');
    expect(content).toContain('2026-10-04T08:00:01.000Z error');
    expect(fencedLines(content)).toEqual(['one', 'two']);
  });

  it('koda_job_log_excerpt omits an absent timestamp and level and reads an unparsed line as its raw text', async () => {
    const entries = vi.fn(async () => ({
      entries: [{ offset: 0, length: 4, text: 'boot' }],
      scannedFrom: 0, scannedTo: 4, truncated: true, complete: false,
    }));
    const tool = jobLogExcerptTool({ entries } as unknown as LogReadService);
    const content = await tool.execute(ctx(), tool.parse({ jobId: 'job-1', stream: 'stdout' }));

    expect(content.split('\n')[0]).toBe('stream stdout, scanned 4 bytes, truncated: true, complete: false');
    expect(fencedLines(content)).toEqual(['boot']);
    expect(content.split('\n')).toEqual([
      'stream stdout, scanned 4 bytes, truncated: true, complete: false',
      '<<koda-data-0000000000000000>>', 'boot', '<<end-koda-data-0000000000000000>>',
    ]);
  });

  it('koda_job_log_excerpt answers no entries under the header when nothing matches', async () => {
    const entries = vi.fn(async () => ({ entries: [], scannedFrom: 0, scannedTo: 12, truncated: false, complete: true }));
    const tool = jobLogExcerptTool({ entries } as unknown as LogReadService);
    const content = await tool.execute(ctx(), tool.parse({ jobId: 'job-1', level: 'error' }));
    expect(content).toBe('stream run, scanned 12 bytes, truncated: false, complete: true\nno entries');
  });

  it('koda_job_log_excerpt answers the expired result for a stream retention removed, not an error', async () => {
    const entries = vi.fn(async () => { throw new FleetLogExpiredException(); });
    const tool = jobLogExcerptTool({ entries } as unknown as LogReadService);
    expect(await tool.execute(ctx(), tool.parse({ jobId: 'job-7' })))
      .toBe('expired: the logs of job job-7 were removed by retention');
  });

  it('koda_job_log_excerpt lets every other read failure through to the executor', async () => {
    const entries = vi.fn(async () => { throw new Error('NotFoundAppException'); });
    const tool = jobLogExcerptTool({ entries } as unknown as LogReadService);
    await expect(tool.execute(ctx(), tool.parse({ jobId: 'ops-job' }))).rejects.toThrow('NotFoundAppException');
  });
});
