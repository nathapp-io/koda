import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  cleanupDeployScriptRuns,
  runDeployScript,
  type DockerCall,
} from './helpers/deploy-script-harness';

afterEach(() => {
  cleanupDeployScriptRuns();
});

function matchingCallIndex(calls: DockerCall[], verb: string): number {
  return calls.findIndex((call) => call.argv.includes(verb));
}

function missingBackupArgument(): string {
  return join(tmpdir(), `koda-missing-${Date.now()}-${Math.random()}.tar.gz`);
}

function plainTextFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'koda-rollback-fixture-'));
  const path = join(dir, 'not-an-archive.tar.gz');
  writeFileSync(path, 'plain text, not a gzip tar archive\n');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('rollback.sh preflight', () => {
  it('AC-1: exits 1 for a missing restore archive before making Docker calls', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', missingBackupArgument()]);
    expect(run.status).toBe(1);
    expect(run.dockerCalls).toEqual([]);
  });

  it('AC-2: reports the resolved path of a missing restore archive', () => {
    const sourcePath = missingBackupArgument();
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', sourcePath]);
    const missingPath = join(run.dir, basename(sourcePath));
    expect(run.output).toContain(`❌ Backup file not found: ${missingPath}`);
  });

  it('AC-3: does not stop or run containers when the archive is missing', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', missingBackupArgument()]);
    expect(run.dockerCalls.every((call) => !call.argv.includes('stop') && !call.argv.includes('run'))).toBe(true);
  });

  it('AC-4: exits 1 for a plain-text restore fixture', () => {
    const fixture = plainTextFixture();
    try {
      const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', fixture.path]);
      expect(run.status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('AC-5: reports the resolved path of an invalid archive', () => {
    const fixture = plainTextFixture();
    try {
      const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', fixture.path]);
      expect(run.output).toContain(`❌ Backup file is not a valid .tar.gz: ${join(run.dir, basename(fixture.path))}`);
    } finally {
      fixture.cleanup();
    }
  });

  it('AC-6: does not stop or run containers for an invalid archive', () => {
    const fixture = plainTextFixture();
    try {
      const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', fixture.path]);
      expect(run.dockerCalls.every((call) => !call.argv.includes('stop') && !call.argv.includes('run'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('AC-7: exits 1 when pulling target images fails before stopping services', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { docker: { failOn: ['pull'] } });
    expect(run.status).toBe(1);
    expect(matchingCallIndex(run.dockerCalls, 'stop')).toBe(-1);
  });

  it('AC-8: does not stop services when pulling target images fails', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { docker: { failOn: ['pull'] } });
    expect(matchingCallIndex(run.dockerCalls, 'stop')).toBe(-1);
  });

  it('AC-9: pulls target images before stopping app services', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1']);
    const pullIndex = matchingCallIndex(run.dockerCalls, 'pull');
    const stopIndex = matchingCallIndex(run.dockerCalls, 'stop');
    expect(run.dockerCalls[pullIndex]?.argv).toEqual([
      'compose', '-f', `${run.dir}/docker-compose.yml`, 'pull', 'api', 'web',
    ]);
    expect(stopIndex).toBeGreaterThan(pullIndex);
  });

  it('AC-10: pulls target images with the requested KODA_VERSION', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1']);
    const pullCall = run.dockerCalls.find((call) => call.argv.includes('pull'));
    expect(pullCall?.kodaVersion).toBe('v0.4.1');
  });
});
