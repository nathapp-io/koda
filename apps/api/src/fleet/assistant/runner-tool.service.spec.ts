import { FleetCommandType } from '../../common/enums';
import { FenceService } from '../sync/fence.service';
import { RunnerToolService } from './runner-tool.service';

/**
 * US-005 (1b-D8): the route's refusals, in the table's order, with the real `FenceService` and a fake job repository.
 * No database: the integration suite (`assistant-runner-tool-route.integration.spec.ts`) drives the same cases over
 * HTTP. AC-16, AC-17 and AC-18 are pinned here; the rest is the ordering the table fixes.
 */
const RUNNING_THREAD_JOB = {
  id: 'j1', command: 'THREAD', threadId: 't1', state: 'RUNNING', runnerId: 'r1', leaseEpoch: 1, projectId: 'p1',
  requestedById: 'u1',
};

const BODY = { toolCallId: 'c1', input: { ref: 'WEB-1' } };

function fixture(over: { job?: unknown; threadsEnabled?: boolean; tool?: boolean } = {}) {
  const job = over.job === undefined ? RUNNING_THREAD_JOB : over.job;
  const jobs = {
    findById: vi.fn(async () => job),
    findPendingCommand: vi.fn(async () => null),
    createCommand: vi.fn(async () => ({})),
  };
  const fence = new FenceService(jobs as never, { record: vi.fn() } as never);
  const registry = { get: vi.fn(() => (over.tool === false ? undefined : { descriptor: { name: 'koda_get_ticket' } })) };
  const execute = vi.fn(async () => ({ content: 'WEB-1 ok', isError: false }));
  const service = new RunnerToolService(
    jobs as never,
    fence,
    { threadsEnabled: over.threadsEnabled ?? true } as never,
    registry as never,
    { execute } as never,
  );
  return { service, jobs, fence, registry, execute };
}

describe('US-005 AC-16: a leaseEpoch that is not a non-negative integer is a 400', () => {
  it.each([undefined, '', 'abc', '-1', '1.5', '1e3', '0x1', ' 1', '01', '9999999999999999999'])('%s', async (raw) => {
    const { service, jobs } = fixture();
    await expect(service.call('r1', 'j1', raw as string | undefined, 'koda_get_ticket', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.toolCall', code: -2, httpStatus: 400 });
    expect(jobs.findById).not.toHaveBeenCalled();
  });

  it('accepts 0 as a non-negative integer', async () => {
    const { service, jobs } = fixture({ job: { ...RUNNING_THREAD_JOB, leaseEpoch: 0 } });
    await expect(service.call('r1', 'j1', '0', 'koda_get_ticket', BODY)).resolves.toEqual({ content: 'WEB-1 ok', isError: false });
    expect(jobs.findById).toHaveBeenCalledWith('j1');
  });
});

describe('US-005 AC-17: a malformed body is a 400', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [BODY]],
    ['a string', 'c1'],
    ['a number', 3],
    ['no toolCallId', { input: { ref: 'WEB-1' } }],
    ['an empty toolCallId', { toolCallId: '', input: {} }],
    ['a numeric toolCallId', { toolCallId: 42, input: {} }],
    ['a 201-character toolCallId', { toolCallId: 'c'.repeat(201), input: {} }],
    ['a non-printable toolCallId', { toolCallId: 'c1\u0000', input: {} }],
    ['a non-ASCII toolCallId', { toolCallId: 'café', input: {} }],
    ['no input key', { toolCallId: 'c1' }],
  ])('rejects %s', async (_name, body) => {
    const { service, jobs, execute } = fixture();
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', body))
      .rejects.toMatchObject({ prefix: 'fleet.toolCall', code: -2, httpStatus: 400 });
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.findById).not.toHaveBeenCalled();
  });

  it('accepts a 200-character toolCallId of printable ASCII', async () => {
    const { service } = fixture();
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', { toolCallId: 'c'.repeat(200), input: {} }))
      .resolves.toEqual({ content: 'WEB-1 ok', isError: false });
  });

  it('accepts a null and a missing-looking input object as the tool input (the tool parses it)', async () => {
    const { service } = fixture();
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', { toolCallId: 'c1', input: null }))
      .resolves.toEqual({ content: 'WEB-1 ok', isError: false });
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', { toolCallId: 'c2', input: {} }))
      .resolves.toEqual({ content: 'WEB-1 ok', isError: false });
  });
});

describe('US-005: the refusals keep the table order', () => {
  it('refuses a disabled kill switch before it reads the job', async () => {
    const { service, jobs } = fixture({ threadsEnabled: false, job: null });
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', BODY))
      .rejects.toMatchObject({ prefix: 'threads.disabled', code: 409 });
    expect(jobs.findById).not.toHaveBeenCalled();
  });

  it('answers 404 fleet.jobs for an unknown job', async () => {
    const { service } = fixture({ job: null });
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.jobs', code: 404 });
  });

  it('answers 409 fleet.fence for a stale epoch, before the job shape is judged', async () => {
    const { service } = fixture({ job: { ...RUNNING_THREAD_JOB, command: 'RUN', threadId: null } });
    await expect(service.call('r1', 'j1', '2', 'koda_get_ticket', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.fence', code: 409 });
  });

  it('answers 409 fleet.fence for another runner holding the lease', async () => {
    const { service } = fixture();
    await expect(service.call('r2', 'j1', '1', 'koda_get_ticket', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.fence', code: 409 });
  });

  it('AC-18: queues no ABANDON when the fence fails', async () => {
    const { service, jobs, fence } = fixture();
    const abandon = vi.spyOn(fence, 'abandon');
    await expect(service.call('r2', 'j1', '1', 'koda_get_ticket', BODY)).rejects.toMatchObject({ prefix: 'fleet.fence' });
    expect(abandon).not.toHaveBeenCalled();
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['a RUN job', { command: 'RUN', threadId: null }],
    ['a THREAD job without a thread id', { command: 'THREAD', threadId: null }],
  ])('answers 409 fleet.notThreadJob for %s, before any tool lookup', async (_name, over) => {
    const { service, registry } = fixture({ job: { ...RUNNING_THREAD_JOB, ...over } });
    await expect(service.call('r1', 'j1', '1', 'koda_drop_tables', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.notThreadJob', code: 409 });
    expect(registry.get).not.toHaveBeenCalled();
  });

  it.each(['ASSIGNED', 'UPLOADING', 'COMPLETED', 'QUEUED'])('answers 409 fleet.jobState for a %s job', async (state) => {
    const { service, registry } = fixture({ job: { ...RUNNING_THREAD_JOB, state } });
    await expect(service.call('r1', 'j1', '1', 'koda_drop_tables', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.jobState', code: 409, args: { state } });
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('answers 409 threads.closing for a THREAD_CLOSE pending at the job epoch, before the tool lookup', async () => {
    const { service, jobs, registry } = fixture();
    jobs.findPendingCommand.mockResolvedValue({ id: 'cmd1' });
    await expect(service.call('r1', 'j1', '1', 'koda_drop_tables', BODY))
      .rejects.toMatchObject({ prefix: 'threads.closing', code: 409 });
    expect(jobs.findPendingCommand).toHaveBeenCalledWith({ jobId: 'j1', type: FleetCommandType.THREAD_CLOSE, leaseEpoch: 1 });
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('answers 404 fleet.assistantTool for an unknown tool', async () => {
    const { service, execute } = fixture({ tool: false });
    await expect(service.call('r1', 'j1', '1', 'koda_drop_tables', BODY))
      .rejects.toMatchObject({ prefix: 'fleet.assistantTool', code: 404 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('looks the tool up on every call, including a replay of a stored toolCallId', async () => {
    const { service, registry, execute } = fixture();
    await service.call('r1', 'j1', '1', 'koda_get_ticket', BODY);
    // The same (jobId, toolCallId) again, but the API no longer serves the tool: still a 404, never a replay.
    registry.get.mockReturnValue(undefined);
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', BODY)).rejects.toMatchObject({ prefix: 'fleet.assistantTool' });
    expect(registry.get).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('US-005 AC-1: a call that passes every gate reaches the executor', () => {
  it('hands the executor the job, toolCallId, name and input, and answers its result', async () => {
    const { service, execute } = fixture();
    await expect(service.call('r1', 'j1', '1', 'koda_get_ticket', BODY))
      .resolves.toEqual({ content: 'WEB-1 ok', isError: false });
    expect(execute).toHaveBeenCalledWith({ jobId: 'j1', toolCallId: 'c1', name: 'koda_get_ticket', input: { ref: 'WEB-1' } });
  });
});


it('workspace AC-8: a WORKSPACE job call reaches the executor with the job, toolCallId, name and input', async () => {
  // 1d2-D8 removed the WORKSPACE refusal (and the `findThreadTokenScope` read that fed it): the job's own
  // `threadId` is the scope, so nothing but the shared gates stands between the route and the executor.
  const { service, registry, execute } = fixture();
  const body = { toolCallId: 'c1', input: { project: 'web' } };
  await expect(service.call('r1', 'j1', '1', 'koda_search_tickets', body)).resolves.toEqual({ content: 'WEB-1 ok', isError: false });
  expect(registry.get).toHaveBeenCalledWith('koda_search_tickets');
  expect(execute).toHaveBeenCalledWith({ jobId: 'j1', toolCallId: 'c1', name: 'koda_search_tickets', input: { project: 'web' } });
});
