jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetJobLogsControllerEntries: jest.fn(),
  fleetJobLogsControllerList: jest.fn(),
  fleetJobsControllerGet: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { formatEntry, LogsDeps, registerLogs } from './fleet-job-logs';
import { fleetJobLogsControllerEntries, fleetJobLogsControllerList, fleetJobsControllerGet } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const ok = <T>(data: T) => ({ ret: 0, data });
const page = (entries: object[], over: object = {}) => ok({
  entries, nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: true, size: 0, complete: false, truncated: false, ...over,
});
const entry = (message: string, over: object = {}) => ({
  offset: 0, length: 10, timestamp: '2026-10-04T08:15:30.123Z', level: 'info', stage: 'run', storyId: 'US-001', message, ...over,
});

describe('koda fleet job logs', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let lines: string[];
  let deps: LogsDeps & { sleep: jest.Mock; onInterrupt: jest.Mock };
  const entries = fleetJobLogsControllerEntries as jest.Mock;
  const list = fleetJobLogsControllerList as jest.Mock;
  const getJob = fleetJobsControllerGet as jest.Mock;
  const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'job', 'logs', ...a]);
  const queries = () => entries.mock.calls.map((c) => c[0].query);

  beforeEach(() => {
    lines = [];
    deps = { sleep: jest.fn(async () => {}), print: (l: string) => { lines.push(l); }, onInterrupt: jest.fn() };
    program = new Command();
    program.exitOverride();
    registerLogs(program.command('job'), deps);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    list.mockResolvedValue(ok({ attempts: [{ leaseEpoch: 3, legacySampled: false, streams: [] }] }));
  });

  afterEach(() => jest.clearAllMocks());

  it('prints the run stream from the start across pages at the latest attempt, then exits 0 (D346, D347)', async () => {
    entries
      .mockResolvedValueOnce(page([entry('one')], { nextCursor: 10, atEnd: false }))
      .mockResolvedValueOnce(page([entry('two', { level: 'warn', stage: undefined })], { nextCursor: 20, atEnd: true }));
    await run('j1');
    expect(list).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(entries).toHaveBeenNthCalledWith(1, { path: { slug: 'web', id: 'j1', stream: 'run' }, query: { cursor: 0, direction: 'forward', limit: 500, leaseEpoch: 3 } });
    expect(queries()[1]).toMatchObject({ cursor: 10 });
    expect(lines).toEqual(['08:15:30 INFO  [run] [US-001] one', '08:15:30 WARN  [US-001] two']);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.onInterrupt).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('maps the filters and --lease-epoch to the query and skips the attempt lookup', async () => {
    entries.mockResolvedValueOnce(page([]));
    await run('j1', '--stream', 'stderr', '--lease-epoch', '2', '--level', 'warn', '--story', 'US-2', '--stage', 'review', '--role', 'implementer', '--grep', 'Timeout');
    expect(list).not.toHaveBeenCalled();
    expect(entries).toHaveBeenCalledWith({
      path: { slug: 'web', id: 'j1', stream: 'stderr' },
      query: { cursor: 0, direction: 'forward', limit: 500, leaseEpoch: 2, level: 'warn', storyId: 'US-2', stage: 'review', role: 'implementer', q: 'Timeout' },
    });
  });

  it('omits leaseEpoch when the job has no attempt with logs yet (D347)', async () => {
    list.mockResolvedValueOnce(ok({ attempts: [] }));
    entries.mockResolvedValueOnce(page([]));
    await run('j1');
    expect(queries()[0]).not.toHaveProperty('leaseEpoch');
  });

  // commander 12 keeps option values across parseAsync on one program: one run per `it`.
  it('prints NDJSON with --json', async () => {
    entries.mockResolvedValueOnce(page([entry('one'), { offset: 10, length: 5, unparsed: true, text: 'boom' }]));
    await run('j1', '--json');
    expect(lines.map((l) => JSON.parse(l).offset)).toEqual([0, 10]);
  });

  it('prints raw text for stdout and for unparsed run lines', async () => {
    entries.mockResolvedValueOnce(page([{ offset: 0, length: 6, text: 'hello' }, { offset: 6, length: 5, unparsed: true, text: 'boom' }]));
    await run('j1', '--stream', 'stdout');
    expect(lines).toEqual(['hello', 'boom']);
  });

  it('follows every 2 s while at the end and stops once the stream is complete', async () => {
    entries
      .mockResolvedValueOnce(page([entry('one')], { nextCursor: 10 }))
      .mockResolvedValueOnce(page([], { nextCursor: 10 }))
      .mockResolvedValueOnce(page([entry('two')], { nextCursor: 20, complete: true }));
    await run('j1', '--follow');
    expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
    expect(deps.sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(queries().map((q) => q.cursor)).toEqual([0, 10, 10]);
    expect(lines).toHaveLength(2);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('stops following a job that ended without a complete stream: state checked every 10th poll, one last page (Review Focus 5)', async () => {
    entries.mockResolvedValue(page([], { nextCursor: 0 }));
    getJob.mockResolvedValueOnce(ok({ state: 'RUNNING' })).mockResolvedValueOnce(ok({ state: 'CANCELLED' }));
    await run('j1', '--follow');
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(getJob).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    // Sleeps 1-19; the 20th poll finds the job CANCELLED and fetches once more instead of sleeping.
    expect(deps.sleep).toHaveBeenCalledTimes(19);
    expect(entries).toHaveBeenCalledTimes(21);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it.each([
    ['--level', 'loud'],
    ['--stream', 'prompt'],
    ['--lease-epoch', '-1'],
  ])('refuses %s %s before any request', async (flag, value) => {
    await expect(run('j1', flag, value)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });

  it('reports an expired log as status 410 and exits 1 (D348)', async () => {
    entries.mockRejectedValueOnce({ ret: 410, message: 'This log was deleted after the retention window' });
    await run('j1');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('deleted after the retention window');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('is registered under koda fleet job', () => {
    const root = new Command();
    fleetCommand(root);
    const job = root.commands.find((c) => c.name() === 'fleet')?.commands.find((c) => c.name() === 'job');
    expect(job?.commands.map((c) => c.name())).toContain('logs');
    expect(job?.description()).toContain('logs');
  });
});

describe('formatEntry (D347)', () => {
  it('renders terminal control bytes visibly instead of sending them to the terminal (review: escape injection)', () => {
    expect(formatEntry('stdout', { offset: 0, length: 1, text: 'ok\x1b]52;c;ZXZpbA==\x07 \rfake\tcol\x9b2J' }))
      .toBe('ok\\x1b]52;c;ZXZpbA==\\x07 \\x0dfake\tcol\\x9b2J');
    expect(formatEntry('run', { offset: 0, length: 1, level: 'info', stage: 's\x1b[2K', storyId: 'US\x08', message: 'm\x7f', timestamp: '2026-10-04T08:00:00Z' }))
      .toBe('08:00:00 INFO  [s\\x1b[2K] [US\\x08] m\\x7f');
  });


  it('cuts the time from the ISO timestamp and omits missing stage and story', () => {
    expect(formatEntry('run', { offset: 0, length: 1, level: 'error', message: 'x', timestamp: 'bad' })).toBe('--:--:-- ERROR x');
    expect(formatEntry('run', { offset: 0, length: 1, unparsed: true, text: 'raw' })).toBe('raw');
    expect(formatEntry('stderr', { offset: 0, length: 1, text: 'err' })).toBe('err');
  });
});
