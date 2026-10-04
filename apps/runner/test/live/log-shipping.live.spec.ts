import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { isProcessAlive } from '../../src/executor/nax-process';
import { findRunLog } from '../../src/watcher/run-log';
import { waitFor } from '../helpers/wait';
import { createWorld, HARNESS_ADMIN, type TestRunner, type World } from '../integration/harness';

/**
 * S2a slice 2, spec §8 "live check" (plan D360): the real `koda-runner run` CLI as its own process against the real
 * built API, with the fake nax writing ~50 MiB of run JSONL (one 3 MiB line) plus 8 MiB each of stdout and stderr over
 * ~2 minutes. The daemon is SIGKILLed mid-run and again after nax wrote its last byte but before it exits; each
 * stored stream must then equal the file on disk (SHA-256), and the read routes the viewer uses must filter it.
 * Unbilled (no real nax). Run: `cd apps/api && bun run test:db:up`, `bunx turbo run build --filter=@nathapp/koda-api`,
 * then `cd apps/runner && KODA_DB_TESTS=1 KODA_LOG_LIVE=1 bun test test/live/log-shipping.live.spec.ts`.
 * `KODA_LOG_LIVE_KEEP=1` keeps the world up at the end and prints how to open the web viewer on it.
 */
setDefaultTimeout(600_000);
const enabled = process.env['KODA_DB_TESTS'] === '1' && process.env['KODA_LOG_LIVE'] === '1';
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const MiB = 1024 * 1024;
const RUN_BYTES = 50 * MiB;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!enabled)('S2a live check: a real daemon process streams complete logs across two crashes', () => {
  let world: World;
  let runner: TestRunner;
  let daemon: Subprocess | null = null;
  let generation = 0;

  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('live');
  }, 300_000);
  afterAll(async () => {
    daemon?.kill('SIGKILL');
    if (process.env['KODA_LOG_LIVE_KEEP'] === '1') await keepOpen();
    await world?.close();
  });

  /** `koda-runner --home <home> run`, the CLI a service runs; its env is what the fake nax inherits. */
  async function spawnDaemon(env: Record<string, string>): Promise<void> {
    generation += 1;
    await world.prisma.runner.update({ where: { name: runner.name }, data: { enabled: true } });
    daemon = Bun.spawn([process.execPath, MAIN, '--home', runner.home.dir, 'run'], {
      env: { ...process.env, ...env },
      stdout: Bun.file(join(world.base, `daemon-${generation}.out`)),
      stderr: Bun.file(join(world.base, `daemon-${generation}.err`)),
    });
  }

  async function killDaemon(): Promise<void> {
    daemon?.kill('SIGKILL');
    await daemon?.exited;
    daemon = null;
  }

  const stored = async (jobId: string, stream: string): Promise<number> =>
    Number((await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream } } }))?.sizeBytes ?? 0);

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${world.api.url}/api/projects/web/fleet/jobs${path}`, { headers: { authorization: `Bearer ${world.adminToken}` } });
    if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: T }).data;
  };

  async function keepOpen(): Promise<void> {
    const flag = join(world.base, 'keep');
    await writeFile(flag, '');
    process.stdout.write([
      '', `API: ${world.api.url} (login ${HARNESS_ADMIN.email} / ${HARNESS_ADMIN.password}, project "web")`,
      `Web: cd apps/web && NUXT_API_INTERNAL_URL=${world.api.url} bun run dev, then open /web/fleet`,
      `Delete ${flag} to tear the world down.`, '',
    ].join('\n'));
    await waitFor(() => !existsSync(flag), { timeoutMs: 3_600_000, intervalMs: 1_000 });
  }

  test('SHA-256 identical after a crash mid-run (watch path) and a crash before nax exits (finish path); filters work', async () => {
    const gate = join(world.base, 'gate-lv');
    const env = {
      FAKE_NAX_LOG_BYTES: String(RUN_BYTES), FAKE_NAX_LONG_LINE_BYTES: String(3 * MiB), FAKE_NAX_PACE_MS: '120',
      FAKE_NAX_STDIO_BYTES: String(8 * MiB), FAKE_NAX_GATE: gate,
    };
    await spawnDaemon(env);
    const jobId = await world.dispatch({ feature: 'lv' });
    await world.waitForJob(jobId, (j) => j.state === 'RUNNING', 120_000);
    const outDir = join(runner.jobDir(jobId), 'nax-out');

    // Crash 1 (watch path): the API holds part of the run log; nax keeps writing while no daemon runs.
    await waitFor(async () => (await stored(jobId, 'run')) > 4 * MiB, { timeoutMs: 120_000, intervalMs: 500, message: 'no 4 MiB of run log reached the API' });
    await killDaemon();
    await Bun.sleep(10_000);
    await spawnDaemon(env);

    // Crash 2 (finish path): nax has written all its padding, then exits while the daemon is down.
    const runPath = async (): Promise<string | null> => findRunLog(outDir, 'lv');
    await waitFor(async () => {
      const path = await runPath();
      return path !== null && (await stat(path)).size >= RUN_BYTES;
    }, { timeoutMs: 300_000, intervalMs: 1_000, message: 'the fake nax never wrote its 50 MiB' });
    await killDaemon();
    const status = JSON.parse(await readFile(join(outDir, 'status.json'), 'utf8')) as { run: { pid: number } };
    await writeFile(gate, '');
    await waitFor(() => !isProcessAlive(status.run.pid), { timeoutMs: 60_000, intervalMs: 250, message: 'the fake nax did not exit after the gate' });
    await spawnDaemon(env);
    // nax pushed while no daemon served its git socket, so the finish may escalate on the push (the integration
    // precedent for the finish path); the logs are what this check is about.
    await world.waitForJob(jobId, (j) => ['COMPLETED', 'ESCALATED'].includes(j.state), 300_000);

    // Success criterion 2: every stream byte-identical, complete, from the stream (not the bundle).
    const local: Record<string, string> = { run: (await runPath()) as string, stdout: join(runner.jobDir(jobId), 'nax.stdout'), stderr: join(runner.jobDir(jobId), 'nax.stderr') };
    for (const [stream, path] of Object.entries(local)) {
      const disk = await readFile(path);
      const kept = await readFile(join(world.base, 'artifacts', 'logs', jobId, '1', `${stream}.log`));
      expect({ stream, size: kept.length, sha: sha(kept) }).toEqual({ stream, size: disk.length, sha: sha(disk) });
      const row = await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream } } });
      expect(row).toMatchObject({ complete: true, truncated: false, source: 'stream' });
      const download = await fetch(`${world.api.url}/api/projects/web/fleet/jobs/${jobId}/logs/${stream}/raw?download=1`, { headers: { authorization: `Bearer ${world.adminToken}` } });
      expect(sha(new Uint8Array(await download.arrayBuffer()))).toBe(sha(disk));
    }
    expect(Number(local.run && (await stat(local.run)).size)).toBeGreaterThanOrEqual(RUN_BYTES);
    expect((await world.events(jobId)).some((e) => e.type === 'log')).toBe(false);

    // The viewer's reads on the 50 MiB log (criterion 3): one bounded scan per request, filters server-side.
    interface Page { entries: Array<{ level?: string; text?: string; truncatedLine?: boolean; unparsed?: boolean }>; nextCursor: number; atEnd: boolean; complete: boolean; size: number }
    const tail = await get<Page>(`/${jobId}/logs/run/entries?direction=backward&level=info`);
    expect(tail.complete).toBe(true);
    expect(tail.entries.length).toBeGreaterThan(0);
    expect(tail.entries.every((e) => e.level === 'info')).toBe(true);
    const head = await get<Page>(`/${jobId}/logs/run/entries?direction=forward&level=info`);
    expect(head).toMatchObject({ entries: [], atEnd: false });                 // the 3 MiB line is cut, unparsed: no match
    expect(head.nextCursor).toBeGreaterThan(0);
    const raw = await get<Page>(`/${jobId}/logs/run/entries?direction=forward`);
    expect(raw.entries[0]).toMatchObject({ unparsed: true, truncatedLine: true });
    const stdout = await get<Page>(`/${jobId}/logs/stdout/entries?direction=forward&q=${encodeURIComponent('stdio 0 ')}`);
    expect(stdout.entries.length).toBe(64);
  });
});
