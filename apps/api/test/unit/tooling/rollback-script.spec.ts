import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

/** A tar archive without gzip compression: bsdtar lists it, the container's `tar -xzf` cannot read it. */
function uncompressedTarFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'koda-rollback-plain-tar-'));
  writeFileSync(join(dir, 'data'), 'payload\n');
  const path = join(dir, 'uncompressed.tar.gz');
  const tar = spawnSync('tar', ['-cf', path, '-C', dir, 'data'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fixtureRoots: string[] = [];
afterAll(() => {
  for (const root of fixtureRoots.splice(0, fixtureRoots.length)) rmSync(root, { recursive: true, force: true });
});

/** A real gzip tar `--restore-db` accepts, kept outside the harness dir like an operator's backup. */
function validArchiveFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-rollback-valid-'));
  fixtureRoots.push(root);
  const archive = join(root, 'backup.tar.gz');
  writeFileSync(join(root, 'data'), 'payload\n');
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'data'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return archive;
}

/** A second environment file a shell `COMPOSE_ENV_FILES` could point the script at. */
function decoyEnvFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-rollback-decoy-'));
  fixtureRoots.push(root);
  const file = join(root, 'other.env');
  writeFileSync(file, 'COMPOSE_PROJECT_NAME=other\n');
  return file;
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
      'compose', '-f', `${run.dir}/docker-compose.yml`, '--project-name', 'koda-local', 'pull', 'api', 'web',
    ]);
    expect(stopIndex).toBeGreaterThan(pullIndex);
  });

  it('AC-10: pulls target images with the requested KODA_VERSION', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1']);
    const pullCall = run.dockerCalls.find((call) => call.argv.includes('pull'));
    expect(pullCall?.kodaVersion).toBe('v0.4.1');
  });

  it('AC-11: rejects an uncompressed tar archive before stopping any service', () => {
    const fixture = uncompressedTarFixture();
    try {
      const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', fixture.path]);

      // `tar -tzf` alone accepts a plain tar on bsdtar (macOS), which the container then cannot extract
      // after the services are already down (review B5).
      expect(run.status).toBe(1);
      expect(run.output).toContain('is not a valid .tar.gz');
      expect(run.dockerCalls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('B1: pins the deployment .env for service calls and only renders the staged replacement', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchiveFixture()], {
      envFile: 'POSTGRES_PASSWORD=pw\n',
      env: { COMPOSE_ENV_FILES: decoyEnvFile() },
    });

    expect(run.status).toBe(0);
    const composeCalls = run.dockerCalls.filter(({ argv }) => argv[0] === 'compose');
    // The staged replacement is only rendered: once for its identity and once for the whole-configuration
    // comparison against the target render.
    const staged = composeCalls.filter(({ argv }) => argv[2]?.startsWith(`${run.dir}/.env.tmp.`));
    expect(staged.length).toBeGreaterThan(0);
    for (const call of staged) {
      expect(call.argv.slice(3)).toEqual(['-f', `${run.dir}/docker-compose.yml`, 'config']);
      expect(call.kodaVersion).toBe('');
    }
    for (const call of composeCalls.filter((call) => !staged.includes(call))) {
      expect(call.argv.slice(0, 5)).toEqual([
        'compose',
        '--env-file',
        `${run.dir}/.env`,
        '-f',
        `${run.dir}/docker-compose.yml`,
      ]);
    }
  });

  it('B1: refuses a Compose project name that follows KODA_VERSION before service operations', () => {
    // `stop` runs under the version `.env` holds and the restore under the target, so a project name built
    // from KODA_VERSION would stop one project and restore into another (review B1).
    const run = runDeployScript('rollback.sh', ['pinned', '--restore-db', validArchiveFixture()], {
      envFile: 'POSTGRES_PASSWORD=pw\nKODA_VERSION=current\nCOMPOSE_PROJECT_NAME=koda-${KODA_VERSION}\n',
    });

    expect(run.status).toBe(1);
    expect(run.output).toContain('changes the resolved Compose project or data volume');
    expect(run.dockerCalls.map((call) => call.argv.at(-1))).toEqual(['config', 'config']);
  });

  it('B1: rejects an indirect Compose project-name change before stopping or pulling', () => {
    const run = runDeployScript('rollback.sh', ['pinned', '--restore-db', validArchiveFixture()], {
      envFile: 'PROJECT_SUFFIX=${KODA_VERSION:-default}\nCOMPOSE_PROJECT_NAME=koda-${PROJECT_SUFFIX}\n',
    });

    expect(run.status).toBe(1);
    expect(run.dockerCalls.map((call) => call.argv.at(-1))).toEqual(['config', 'config']);
  });

  it('rejects a version-dependent /data volume even when the project is unchanged', () => {
    const run = runDeployScript('rollback.sh', ['pinned', '--restore-db', validArchiveFixture()], {
      envFile: 'COMPOSE_PROJECT_NAME=koda-staging\nKODA_VERSION=current\n',
      env: { KODA_DEPLOY_HARNESS_VOLUME_NAME: 'data-${KODA_VERSION}' },
    });

    expect(run.status).toBe(1);
    expect(run.output).toContain('changes the resolved Compose project or data volume');
    // No pull, stop, lock creation, or restore.
    expect(run.dockerCalls.map((call) => call.argv.at(-1))).toEqual(['config', 'config']);
  });

  it('B1: fails safely when Compose cannot resolve an invalid shell project name', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      env: { COMPOSE_PROJECT_NAME: 'koda-$KODA_VERSION' },
    });

    expect(run.status).toBe(1);
    expect(run.dockerCalls.map((call) => call.argv.at(-1))).toEqual(['config']);
  });

  it('B1: still rolls back a version-independent Compose project name', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: 'POSTGRES_PASSWORD=pw\nCOMPOSE_PROJECT_NAME=koda-staging\n',
    });

    expect(run.status).toBe(0);
    const serviceCalls = run.dockerCalls.filter(({ argv }) => argv[0] === 'compose' && !argv.includes('config'));
    expect(serviceCalls.length).toBeGreaterThan(0);
    for (const { argv } of serviceCalls) {
      expect(argv.slice(argv.indexOf('--project-name'), argv.indexOf('--project-name') + 2))
        .toEqual(['--project-name', 'koda-staging']);
    }
  });
});
