import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  DEFAULT_PG_DUMP,
  cleanupDeployScriptRuns,
  runDeployScript,
  type DockerCall,
} from './helpers/deploy-script-harness';

const DUMP_COMPLETE_LINE = '-- PostgreSQL database dump complete';
const INCOMPLETE_PG_DUMP = ['--', '-- PostgreSQL database dump', '--', ''].join('\n');

afterEach(() => {
  cleanupDeployScriptRuns();
});

function callIndex(calls: DockerCall[], predicate: (argv: string[]) => boolean): number {
  return calls.findIndex((call) => predicate(call.argv));
}

function isPgDumpCall(argv: string[]): boolean {
  return argv.some((argument) => argument.includes('pg_dump'));
}

function dbDumpFiles(dir: string): string[] {
  return readdirSync(join(dir, 'backups')).filter((name) => /^koda-db-.+\.sql\.gz$/.test(name));
}

describe('backup-db.sh', () => {
  it('AC-1: starts the postgres service before it dumps', () => {
    const run = runDeployScript('backup-db.sh', []);

    const startIndex = callIndex(run.dockerCalls, (argv) => argv.includes('--wait'));
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(run.dockerCalls[startIndex]?.argv).toEqual([
      'compose',
      '-f',
      `${run.dir}/docker-compose.yml`,
      'up',
      '-d',
      '--wait',
      'postgres',
    ]);

    const dumpIndex = callIndex(run.dockerCalls, isPgDumpCall);
    expect(dumpIndex).toBeGreaterThan(startIndex);
  });

  it('AC-2: exits 0 on a complete dump', () => {
    const run = runDeployScript('backup-db.sh', []);

    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBeGreaterThanOrEqual(0);
    expect(run.status).toBe(0);
  });

  it('AC-3: gzips exactly the dump pg_dump produced into one timestamped file', () => {
    const run = runDeployScript('backup-db.sh', []);

    expect(DEFAULT_PG_DUMP.split('\n')).toContain(DUMP_COMPLETE_LINE);
    const files = dbDumpFiles(run.dir);
    expect(files).toHaveLength(1);
    const decompressed = gunzipSync(readFileSync(join(run.dir, 'backups', String(files[0]))));
    expect(decompressed.toString('utf8')).toBe(DEFAULT_PG_DUMP);
  });

  it('AC-4: archives the data volume through the project api service with the exact argv', () => {
    const run = runDeployScript('backup-db.sh', []);

    const archiveCall = run.dockerCalls.find((call) =>
      call.argv.some((argument) => argument.startsWith('tar -czf')),
    );
    expect(archiveCall).toBeDefined();

    const tarCommand = (archiveCall?.argv ?? []).find((argument) => argument.startsWith('tar -czf'));
    const stamp = /^tar -czf \/backup\/koda_data-(\d{8}-\d{6})\.tar\.gz -C \/data \.$/.exec(
      tarCommand ?? '',
    )?.[1];
    if (stamp === undefined) throw new Error(`unexpected archive command: ${tarCommand}`);

    expect(archiveCall?.argv).toEqual([
      'compose',
      '-f',
      `${run.dir}/docker-compose.yml`,
      'run',
      '--rm',
      '--no-deps',
      '--user',
      'root',
      '--entrypoint',
      'sh',
      '-v',
      `${run.dir}/backups:/backup`,
      'api',
      '-c',
      `tar -czf /backup/koda_data-${stamp}.tar.gz -C /data .`,
    ]);
  });

  it('AC-5: runs every docker call through the compose plugin', () => {
    const run = runDeployScript('backup-db.sh', []);

    expect(run.dockerCalls.length).toBeGreaterThan(0);
    for (const call of run.dockerCalls) {
      expect(call.argv[0]).toBe('compose');
    }
  });

  it('AC-6: exits 1 when the dump fails', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDumpExit: 1 } });
    expect(run.status).toBe(1);
  });

  it('AC-7: reports the failed dump', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDumpExit: 1 } });
    expect(run.output).toContain('❌ Postgres dump failed');
  });

  it('AC-8: keeps no dump file when the dump fails', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDumpExit: 1 } });

    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBeGreaterThanOrEqual(0);
    expect(dbDumpFiles(run.dir)).toEqual([]);
  });

  it('AC-9: exits 1 when the dump lacks the pg_dump completion line', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDump: INCOMPLETE_PG_DUMP } });
    expect(run.status).toBe(1);
  });

  it('AC-10: keeps no dump file when the dump is incomplete', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDump: INCOMPLETE_PG_DUMP } });

    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBeGreaterThanOrEqual(0);
    expect(dbDumpFiles(run.dir)).toEqual([]);
  });

  it('AC-11: reads the whole decompressed stream past the completion line', () => {
    const pgDump = `${DEFAULT_PG_DUMP}${'x'.repeat(1024 * 1024 + 64)}`;
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDump } });

    expect(run.status).toBe(0);
    expect(dbDumpFiles(run.dir)).toHaveLength(1);
  });

  it('AC-12: exits non-zero when postgres cannot be started', () => {
    const run = runDeployScript('backup-db.sh', [], {
      docker: { failOn: ['up -d --wait postgres'] },
    });
    expect(run.status).not.toBe(0);
  });

  it('AC-13: never dumps when postgres cannot be started', () => {
    const run = runDeployScript('backup-db.sh', [], {
      docker: { failOn: ['up -d --wait postgres'] },
    });

    expect(callIndex(run.dockerCalls, (argv) => argv.includes('--wait'))).toBeGreaterThanOrEqual(0);
    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBe(-1);
  });

  it('AC-14: exits non-zero when the data volume archive fails', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { failOn: ['tar -czf'] } });

    // The dump itself succeeded: only the archive call failed.
    expect(dbDumpFiles(run.dir)).toHaveLength(1);
    expect(run.status).not.toBe(0);
  });

  it('AC-15: reports the incomplete dump as a failed dump', () => {
    const run = runDeployScript('backup-db.sh', [], { docker: { pgDump: INCOMPLETE_PG_DUMP } });
    expect(run.output).toContain('❌ Postgres dump failed');
  });
});
