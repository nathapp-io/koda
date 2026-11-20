import { spawnSync } from 'node:child_process';
import { vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { cleanupDeployScriptRuns, runDeployScript } from './helpers/deploy-script-harness';

vi.setConfig({ testTimeout: 30_000 });

const fixtureRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-deploy-fixture-'));
  fixtureRoots.push(root);
  return root;
}

/** A real gzip tar, like the ones `rollback.sh --restore-db` restores. */
function gzipTarFixture(name: string): string {
  const root = fixtureRoot();
  const archive = join(root, name);
  writeFileSync(join(root, 'README.txt'), 'volume contents\n');
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'README.txt'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return archive;
}

afterAll(() => {
  for (const root of fixtureRoots.splice(0, fixtureRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  cleanupDeployScriptRuns();
});

describe('deploy script harness', () => {
  it('copies a fixture passed as an absolute argument under dir and passes the copy', () => {
    const archive = gzipTarFixture('koda_data-20260101-000000.tar.gz');
    const run = runDeployScript('rollback.sh', ['v0.3.0', '--restore-db', archive]);

    const copied = join(run.dir, basename(archive));
    expect(readFileSync(copied)).toEqual(readFileSync(archive));
    expect(run.output).not.toContain('Backup file not found');
    expect(run.dockerCalls.some((call) => call.argv.some((argument) => argument.endsWith(':/backup:ro')))).toBe(true);
  });

  it('resolves a missing fixture under dir without creating it', () => {
    const missing = join(fixtureRoot(), 'koda_data-20260101-000000.tar.gz');
    const run = runDeployScript('rollback.sh', ['v0.3.0', '--restore-db', missing]);

    const resolved = join(run.dir, basename(missing));
    expect(run.output).toContain(`❌ Backup file not found: ${resolved}`);
    expect(existsSync(resolved)).toBe(false);
  });

  it('copies only the deployment files a script reads', () => {
    // A developer's local `deployments/example/.env` (or `backups/` dumps) must never become a test's
    // starting state: `.env` comes from the fixture alone (review B10).
    const run = runDeployScript('backup-db.sh', []);

    expect(readdirSync(run.dir).sort()).toEqual([
      '.harness',
      'backup-db.sh',
      'backups',
      'deploy.sh',
      'docker-compose.yml',
      'rollback.sh',
    ]);
  });

  it('writes .env with the requested mode before the script starts', () => {
    const run = runDeployScript('backup-db.sh', [], { envFile: 'API_PORT=3100\n', envFileMode: 0o600 });

    const envFile = join(run.dir, '.env');
    expect(readFileSync(envFile, 'utf8')).toBe('API_PORT=3100\n');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it('keeps the operator environment out of the script', () => {
    const previous = process.env.KODA_VERSION;
    process.env.KODA_VERSION = 'v9.9.9';
    try {
      const isolated = runDeployScript('backup-db.sh', []);
      expect(isolated.dockerCalls.map((call) => call.kodaVersion)).toEqual(
        isolated.dockerCalls.map(() => ''),
      );

      const passed = runDeployScript('backup-db.sh', [], { env: { KODA_VERSION: 'v1.2.3' } });
      expect(passed.dockerCalls.map((call) => call.kodaVersion)).toEqual(
        passed.dockerCalls.map(() => 'v1.2.3'),
      );
    } finally {
      if (previous === undefined) delete process.env.KODA_VERSION;
      else process.env.KODA_VERSION = previous;
    }
  });
});
