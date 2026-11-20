import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { cleanupDeployScriptRuns, runDeployScript } from './helpers/deploy-script-harness';

const fixtureRoots: string[] = [];
function validArchive(name = 'backup.tar.gz'): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-rollback-archive-'));
  fixtureRoots.push(root);
  const archive = join(root, name);
  writeFileSync(join(root, 'data'), 'payload');
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'data'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return archive;
}
afterEach(() => cleanupDeployScriptRuns());
afterAll(() => { for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('rollback.sh restore and portable .env update', () => {
  it('AC-1: restores between stop and restart after pull', () => {
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
  });
  it('AC-2: restores through the project api with the exact argv', () => {
    const archive = validArchive();
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive]);
    expect(run.dockerCalls.find((call) => call.argv.includes('run'))?.argv).toEqual([
      'compose', '-f', `${run.dir}/docker-compose.yml`, 'run', '--rm', '--no-deps', '--user', 'root', '--entrypoint', 'sh',
      '-v', `${run.dir}:/backup:ro`, 'api', '-c', `find /data -mindepth 1 -delete && tar -xzf /backup/${basename(archive)} -C /data`,
    ]);
  });
  it('F1: shell-quotes archive basenames containing command separators', () => {
    const archive = validArchive('backup.tar.gz;id');
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive]);
    const restoreCall = run.dockerCalls.find((call) => call.argv.includes('run'));
    expect(restoreCall?.argv[restoreCall.argv.indexOf('-c') + 1]).toBe(
      'find /data -mindepth 1 -delete && tar -xzf /backup/backup.tar.gz\\;id -C /data',
    );
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
    expect(readFileSync(join(run.dir, '.env'), 'utf8').split(/\r?\n/).filter(Boolean)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1', 'WEB_PORT=3101']);
  });
  it('AC-6: appends version when missing', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'POSTGRES_PASSWORD=pw\n' });
    expect(readFileSync(join(run.dir, '.env'), 'utf8').split(/\r?\n/).filter(Boolean)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1']);
  });
  it('AC-7: inserts a newline before version for a file without trailing newline', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'POSTGRES_PASSWORD=pw' });
    expect(readFileSync(join(run.dir, '.env'), 'utf8').split(/\r?\n/).filter(Boolean)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1']);
  });
  it('AC-8: updates every duplicate version assignment in place', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'KODA_VERSION=v0.3.0\nX=1\nKODA_VERSION=v0.4.2\n' });
    expect(readFileSync(join(run.dir, '.env'), 'utf8').split(/\r?\n/).filter(Boolean)).toEqual(['KODA_VERSION=v0.4.1', 'X=1', 'KODA_VERSION=v0.4.1']);
  });
  it('AC-9: creates .env when absent', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1']);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe('KODA_VERSION=v0.4.1\n');
  });
  it('AC-10: preserves restrictive .env permissions', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: 'KODA_VERSION=v0.4.2\n', envFileMode: 0o600 });
    expect(statSync(join(run.dir, '.env')).mode & 0o777).toBe(0o600);
  });
});
