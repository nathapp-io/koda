jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetIngestControllerList: jest.fn(),
  fleetIngestControllerBackfill: jest.fn(),
  fleetIngestControllerRerunJob: jest.fn(),
  fleetIngestControllerRerunOutdated: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import {
  fleetIngestControllerBackfill,
  fleetIngestControllerList,
  fleetIngestControllerRerunJob,
  fleetIngestControllerRerunOutdated,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com' };
const ok = (data: unknown) => ({ ret: 0, data });
const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1', jobId: 'j1', leaseEpoch: 1, projectId: 'p1', status: 'failed', attempts: 5, parserVersion: 1,
  files: { cost: 'done:v8' }, error: 'bundle expired', ingestedAt: null, updatedAt: new Date().toISOString(), ...over,
});

describe('koda fleet ingest', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const out = () => logSpy.mock.calls.flat().join('\n');
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'ingest', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('status lists ingest rows with a status filter and paging', async () => {
    (fleetIngestControllerList as jest.Mock).mockResolvedValue(ok({ total: 1, current: 1, size: 20, hasNext: true, hasPrev: false, records: [row()] }));
    await run('status', '--status', 'failed');
    expect(fleetIngestControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20, status: 'failed' } });
    expect(out()).toContain('bundle expired');
    expect(out()).toContain('cost=done:v8');
    expect(out()).toContain('Next: --page 2');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('status rejects an unknown status', async () => {
    await expect(run('status', '--status', 'bogus')).rejects.toThrow();
    expect(fleetIngestControllerList).not.toHaveBeenCalled();
  });

  it('backfill and rerun report how many bundles were queued', async () => {
    (fleetIngestControllerBackfill as jest.Mock).mockResolvedValue(ok({ queued: 3 }));
    await run('backfill');
    expect(out()).toContain('Queued 3 bundle(s) for ingest');
    (fleetIngestControllerRerunJob as jest.Mock).mockResolvedValue(ok({ queued: 1 }));
    await run('rerun', 'j1');
    expect(fleetIngestControllerRerunJob).toHaveBeenCalledWith({ path: { jobId: 'j1' } });
    (fleetIngestControllerRerunOutdated as jest.Mock).mockResolvedValue(ok({ queued: 0 }));
    await run('rerun', '--all');
    expect(fleetIngestControllerRerunOutdated).toHaveBeenCalled();
    expect(out()).toContain('Queued 0 bundle(s) for ingest');
  });

  it('rerun needs exactly one of a job id or --all', async () => {
    await run('rerun');
    await run('rerun', 'j1', '--all');
    expect(fleetIngestControllerRerunJob).not.toHaveBeenCalled();
    expect(fleetIngestControllerRerunOutdated).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
  });
});
