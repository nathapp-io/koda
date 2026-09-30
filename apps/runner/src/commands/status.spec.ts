import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHome } from '../config/runner-config';
import { writeIdentity } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import { NetworkError } from '../sync/http';
import { assignFor } from '../../test/helpers/assign';
import { makeTempDirs } from '../../test/helpers/tmp';
import { collectStatus, formatStatus } from './status';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const client = (result: () => Promise<unknown>) => ({ makeClient: () => ({ me: result as never }), env: {} as NodeJS.ProcessEnv });

describe('collectStatus and formatStatus (D48)', () => {
  test('not enrolled: says so and touches nothing', async () => {
    const dir = await tmp.make('status');
    const report = await collectStatus(join(dir, 'home'), client(async () => { throw new Error('unused'); }));
    expect(report).toMatchObject({ enrolled: false });
    expect(formatStatus(report)).toMatch(/not enrolled/i);
  });
  test('enrolled: identity, journal counts and jobs, and the server view with capacity', async () => {
    const dir = await tmp.make('status');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'),
      capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
    }));
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'kr_secret', serverUrl: 'https://koda.example.com', name: 'box', enrolledAt: 't' });
    const journal = Journal.open(home.journalPath);
    journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/w/j1' });
    journal.appendEvent('j1', 2, 'log', { stream: 'run', text: 'x' });
    journal.close();
    const report = await collectStatus(home.dir, client(async () => ({ id: 'r1', name: 'box', labels: [], capacity: 2, enabled: true })));
    expect(report).toMatchObject({
      enrolled: true, name: 'box', runnerId: 'r1', serverUrl: 'https://koda.example.com',
      journal: { activeJobs: 1, pendingEvents: 1, jobs: [{ jobId: 'j1', leaseEpoch: 2, command: 'RUN', feature: 'feat', state: 'ASSIGNED' }] },
      server: { reachable: true, capacity: 2, enabled: true },
    });
    const text = formatStatus(report);
    expect(text).toContain('box');
    expect(text).toContain('j1');
    expect(text).not.toContain('kr_secret');
    expect(JSON.stringify(report)).not.toContain('kr_secret');
  });
  test('reads the journal read-only: a daemon may hold it open and keep writing (D72)', async () => {
    const dir = await tmp.make('status');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'),
      capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
    }));
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'k', serverUrl: 'https://koda.example.com', name: 'box', enrolledAt: 't' });
    const daemonsJournal = Journal.open(home.journalPath);              // stays open, like the running daemon
    daemonsJournal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/j1' });
    const report = await collectStatus(home.dir, client(async () => ({ id: 'r1', name: 'box', labels: [], capacity: 1, enabled: true })));
    expect(report.journal?.activeJobs).toBe(1);
    daemonsJournal.insertJob({ assign: assignFor('RUN', { jobId: 'j2' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/j2' });   // the writer is not blocked
    expect(daemonsJournal.activeCount()).toBe(2);
    daemonsJournal.close();
  });
  test('an unreachable server is reported, not thrown', async () => {
    const dir = await tmp.make('status');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'),
      capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
    }));
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'k', serverUrl: 'https://koda.example.com', name: 'box', enrolledAt: 't' });
    const report = await collectStatus(home.dir, client(async () => { throw new NetworkError('ECONNREFUSED'); }));
    expect(report.server).toEqual({ reachable: false, error: 'ECONNREFUSED' });
    expect(formatStatus(report)).toContain('unreachable');
  });
});
