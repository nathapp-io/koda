import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupDeployScriptRuns, runDeployScript, type DockerCall } from './helpers/deploy-script-harness';

const fixtureRoots: string[] = [];
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-rollback-archive-'));
  fixtureRoots.push(root);
  return root;
}
function validArchive(name = 'backup.tar.gz'): string {
  const root = fixtureRoot();
  const archive = join(root, name);
  writeFileSync(join(root, 'data'), 'payload');
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'data'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return archive;
}
afterEach(() => cleanupDeployScriptRuns());
afterAll(() => { for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function restoreRuns(calls: DockerCall[]): DockerCall[] {
  return calls.filter((call) => call.argv.includes('run'));
}
function commandOf(call: DockerCall): string {
  return call.argv[call.argv.indexOf('-c') + 1] ?? '';
}
const BACKUP_MOUNT_SUFFIX = ':/backup:ro';
function mountSource(call: DockerCall): string {
  const mount = call.argv.find((argument) => argument.endsWith(BACKUP_MOUNT_SUFFIX));
  if (mount === undefined) throw new Error(`no read-only /backup mount in: ${call.argv.join(' ')}`);
  return mount.slice(0, -BACKUP_MOUNT_SUFFIX.length);
}
function envLines(run: { dir: string }): string[] {
  return readFileSync(join(run.dir, '.env'), 'utf8').split(/\r?\n/).filter(Boolean);
}

describe('rollback.sh restore and portable .env update', () => {
  it('AC-1: verifies and restores between stop and restart after pull', () => {
    const archive = validArchive();
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive]);
    const indexes = [
      run.dockerCalls.findIndex((call) => call.argv.includes('pull')),
      run.dockerCalls.findIndex((call) => call.argv.includes('stop')),
      run.dockerCalls.findIndex((call) => call.argv.includes('run')),
      run.dockerCalls.findIndex((call) => call.argv.includes('up')),
    ];
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(restoreRuns(run.dockerCalls)).toHaveLength(2);
  });
  it('AC-2: installs the staged archive through the project api with the exact argv', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()]);
    const install = restoreRuns(run.dockerCalls)[1];
    const stage = mountSource(install);
    expect(install.argv.slice(0, 12)).toEqual([
      'compose', '-f', `${run.dir}/docker-compose.yml`, 'run', '--rm', '--no-deps', '--user', 'root',
      '--entrypoint', 'sh', '-v', `${stage}${BACKUP_MOUNT_SUFFIX}`,
    ]);
    expect(install.argv.slice(12, 14)).toEqual(['api', '-c']);
    expect(install.argv.slice(15)).toEqual(['koda-restore', 'koda-restore.tar.gz']);
  });
  it('B2: extracts the staged archive inside the container before the install touches /data', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()]);
    const [check, install] = restoreRuns(run.dockerCalls);

    expect(mountSource(check)).toBe(mountSource(install));
    expect(commandOf(check)).toContain('tar -xzf "/backup/$1"');
    expect(commandOf(check)).not.toContain('/data');
    // The old data survives until the staged restore is in place: the extract goes to a staging directory
    // in the volume and the current entries are moved aside, not deleted (review B2).
    expect(commandOf(install)).toContain('/data/.koda-restore-staging');
    expect(commandOf(install)).toContain('/data/.koda-restore-previous');
    expect(commandOf(install)).not.toContain('find /data -mindepth 1 -delete');
  });
  it('B2: stages a symlinked archive as a regular file instead of mounting only its directory', () => {
    const root = fixtureRoot();
    mkdirSync(join(root, 'real'));
    mkdirSync(join(root, 'link'));
    writeFileSync(join(root, 'real', 'payload'), 'payload');
    const target = join(root, 'real', 'backup.tar.gz');
    const tar = spawnSync('tar', ['-czf', target, '-C', join(root, 'real'), 'payload'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    const link = join(root, 'link', 'backup.tar.gz');
    symlinkSync(target, link);

    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', link]);

    expect(run.status).toBe(0);
    const [check, install] = restoreRuns(run.dockerCalls);
    // The container only sees the mounted directory, so mounting the directory that holds the symlink
    // would hide its target. The script copies the archive into a staging directory and mounts that.
    const stage = mountSource(check);
    expect(stage).not.toBe(run.dir);
    expect(stage.startsWith(run.dir)).toBe(true);
    expect(mountSource(install)).toBe(stage);
    expect(existsSync(stage)).toBe(false);
  });
  it('B3: never restores or restarts when the app services cannot be stopped', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      docker: { failOn: ['stop api web'] },
    });

    expect(run.status).not.toBe(0);
    expect(restoreRuns(run.dockerCalls)).toEqual([]);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
  });
  it('F1: keeps a backup file name with command separators out of the container command', () => {
    const archive = validArchive('backup.tar.gz;id');
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive]);

    const install = restoreRuns(run.dockerCalls)[1];
    expect(install.argv.slice(15)).toEqual(['koda-restore', 'koda-restore.tar.gz']);
    expect(commandOf(install)).not.toContain('backup.tar.gz;id');
    expect(run.dockerCalls.flatMap((call) => call.argv).some((argument) => argument.includes('backup.tar.gz;id'))).toBe(false);
  });
  it('AC-3: restores using the target version', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()]);
    expect(run.dockerCalls.find((call) => call.argv.includes('run'))?.kodaVersion).toBe('v0.4.1');
  });
  it('AC-4: does not run a container without restore option', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1']);
    expect(run.dockerCalls.some((call) => call.argv.includes('run'))).toBe(false);
  });
  it('AC-5: replaces version while preserving surrounding line order', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'POSTGRES_PASSWORD=pw\nKODA_VERSION=v0.4.2\nWEB_PORT=3101\n' });
    expect(envLines(run)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1', 'WEB_PORT=3101']);
  });
  it('AC-6: appends version when missing', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'POSTGRES_PASSWORD=pw\n' });
    expect(envLines(run)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1']);
  });
  it('AC-7: inserts a newline before version for a file without trailing newline', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'POSTGRES_PASSWORD=pw' });
    expect(envLines(run)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1']);
  });
  it('AC-8: updates every duplicate version assignment in place', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'KODA_VERSION=v0.3.0\nX=1\nKODA_VERSION=v0.4.2\n' });
    expect(envLines(run)).toEqual(['KODA_VERSION=v0.4.1', 'X=1', 'KODA_VERSION=v0.4.1']);
  });
  it('AC-9: creates .env when absent', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1']);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe('KODA_VERSION=v0.4.1\n');
  });
  it('AC-10: preserves restrictive .env permissions', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'KODA_VERSION=v0.4.2\n', envFileMode: 0o600 });
    expect(statSync(join(run.dir, '.env')).mode & 0o777).toBe(0o600);
  });
  it('B6: restarts the services on the requested version, not an inherited one', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: 'POSTGRES_PASSWORD=pw\n',
      env: { KODA_VERSION: 'v0.9.0' },
    });

    expect(run.status).toBe(0);
    expect(run.dockerCalls.find((call) => call.argv.includes('up'))?.kodaVersion).toBe('v0.4.1');
  });
  it('B6: rewrites a later export-style version assignment', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: 'POSTGRES_PASSWORD=pw\nexport KODA_VERSION = v0.9.0\n',
    });

    expect(envLines(run)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1']);
    expect(run.dockerCalls.find((call) => call.argv.includes('up'))?.kodaVersion).toBe('v0.4.1');
  });
});
