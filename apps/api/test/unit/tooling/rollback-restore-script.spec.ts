import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
/**
 * A gzip tar that lists fine — `gzip -t` and `tar -tzf` both accept it — but whose extraction fails: it holds
 * `a/b` as a file under a directory `a`, then `a` itself as a file, so creating the second entry cannot work.
 * That is the "the archive does not extract" case the swap must survive (review B13).
 */
function unextractableArchive(name = 'conflicting.tar.gz'): string {
  const first = fixtureRoot();
  const second = fixtureRoot();
  mkdirSync(join(first, 'a'));
  writeFileSync(join(first, 'a', 'b'), 'nested');
  writeFileSync(join(second, 'a'), 'flat');
  const tarPath = join(fixtureRoot(), 'conflicting.tar');
  const tar = spawnSync('tar', ['-cf', tarPath, '-C', first, 'a/b', '-C', second, 'a'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const archive = join(fixtureRoot(), name);
  const gzip = spawnSync('gzip', ['-c', tarPath]);
  if (gzip.status !== 0) throw new Error(`gzip failed: ${gzip.stderr?.toString() ?? ''}`);
  writeFileSync(archive, gzip.stdout);
  // Both checks run on the gzipped archive, never on the intermediate tar: listing an uncompressed tar with
  // `-z` silently works on bsdtar (macOS) but fails on GNU tar (CI), which cannot read a non-gzip stream
  // through the gzip filter ("gzip: stdin: not in gzip format").
  const integrity = spawnSync('gzip', ['-t', archive], { encoding: 'utf8' });
  if (integrity.status !== 0) throw new Error(`the fixture must be a valid gzip: ${integrity.stderr}`);
  const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`the fixture must list: ${listed.stderr}`);
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
/** The fake data volume a restore really runs against (the `docker` stub executes the container command). */
function volumeEntries(run: { dataDir: string }): string[] {
  return readdirSync(run.dataDir).sort();
}

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
    // One container run: the archive is extracted once, into staging on the target volume (review B13).
    expect(restoreRuns(run.dockerCalls)).toHaveLength(1);
  });
  it('AC-2: installs the staged archive through the project api with the exact argv', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()]);
    const install = restoreRuns(run.dockerCalls)[0];
    const stage = mountSource(install);
    expect(install.argv.slice(0, install.argv.indexOf('-c') + 1)).toEqual([
      'compose', '-f', `${run.dir}/docker-compose.yml`, '--project-name', 'koda-local',
      'run', '--rm', '--no-deps', '--user', 'root', '--entrypoint', 'sh',
      '--name', 'koda-rollback-worker-koda-local_koda_data', '-v', `${stage}${BACKUP_MOUNT_SUFFIX}`, 'api', '-c',
    ]);
    expect(install.argv.slice(-2)).toEqual(['koda-restore', 'koda-restore.tar.gz']);
  });
  it('B13: extracts once into staging on the volume before it moves anything', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()]);
    const [install] = restoreRuns(run.dockerCalls);
    const command = commandOf(install);

    // The old data survives until the staged restore is in place: the extract goes to a staging directory
    // in the volume, never to the container's writable layer, and the current entries are moved aside
    // rather than deleted (review B2, B13).
    expect(command).toContain('stage=/data/.koda-restore-staging');
    const extract = 'tar --numeric-owner -xzpf "/backup/$1" -C "$stage/tree"';
    expect(command.split(extract)).toHaveLength(2);
    expect(command.indexOf(extract)).toBeLessThan(command.indexOf('mv "$entry" "$previous/entries/"'));
    expect(command).toContain('/data/.koda-restore-previous');
    expect(command).not.toContain('/tmp');
    expect(command).not.toContain('find /data -mindepth 1 -delete');
  });
  it('B13: leaves the current data in place when the extraction fails', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', unextractableArchive()], {
      seedVolume: (dataDir) => writeFileSync(join(dataDir, 'keep.txt'), 'current data\n'),
    });

    expect(run.status).not.toBe(0);
    expect(restoreRuns(run.dockerCalls)).toHaveLength(1);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
    // Nothing was moved aside, so the interrupted-restore directory does not exist either.
    expect(volumeEntries(run)).toEqual(['keep.txt']);
    expect(readFileSync(join(run.dataDir, 'keep.txt'), 'utf8')).toBe('current data\n');
  });
  it('B2: refuses to delete the data an interrupted restore moved aside', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      seedVolume: (dataDir) => {
        mkdirSync(join(dataDir, '.koda-restore-previous'));
        writeFileSync(join(dataDir, '.koda-restore-previous', 'keep.txt'), 'the only copy\n');
        writeFileSync(join(dataDir, 'current.txt'), 'new data\n');
      },
    });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('An earlier restore was interrupted');
    // The recovery directory is the only remaining copy: it must survive, and the new archive must not be
    // installed over it (review B2).
    expect(readFileSync(join(run.dataDir, '.koda-restore-previous', 'keep.txt'), 'utf8')).toBe('the only copy\n');
    expect(existsSync(join(run.dataDir, 'data'))).toBe(false);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
  });
  it('B12: moves entries whose name begins with two dots and counts dangling symlinks as entries', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      seedVolume: (dataDir) => {
        writeFileSync(join(dataDir, '..archive-notes'), 'two leading dots\n');
        writeFileSync(join(dataDir, '.hidden'), 'dotfile\n');
        symlinkSync(join(dataDir, 'already-gone'), join(dataDir, 'dangling'));
      },
    });

    expect(run.status).toBe(0);
    // The archive's own entry is installed, and every entry that was there before — including `..name` and a
    // symlink whose target does not exist — went with the swap (review B12).
    expect(volumeEntries(run)).toEqual(['data']);
  });
  it('B12: keeps a dangling symlink in the restored archive', () => {
    const root = fixtureRoot();
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    const archive = join(fixtureRoot(), 'with-symlink.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'dangling'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);

    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive]);

    expect(run.status).toBe(0);
    expect(volumeEntries(run)).toEqual(['dangling']);
  });
  it.each(['.koda-restore-staging', '.koda-restore-previous'].flatMap((name) =>
    [false, true].map((dangling) => ({ name, dangling })),
  ))('B12: rejects reserved archive name $name (dangling: $dangling)', ({ name, dangling }) => {
    const root = fixtureRoot();
    if (dangling) symlinkSync('missing', join(root, name));
    else writeFileSync(join(root, name), 'archived');
    writeFileSync(join(root, 'payload'), 'restored');
    const archive = join(fixtureRoot(), 'reserved-name.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', root, name, 'payload'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);

    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive], {
      seedVolume: (dir) => writeFileSync(join(dir, 'original'), 'keep'),
    });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('reserved name');
    expect(volumeEntries(run)).toEqual(['original']);
    expect(readFileSync(join(run.dataDir, 'original'), 'utf8')).toBe('keep');
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
  });
  function backupShapedArchive(): { archive: string; root: string } {
    const root = fixtureRoot();
    chmodSync(root, 0o750);
    writeFileSync(join(root, 'a'), 'restored a');
    writeFileSync(join(root, 'z'), 'restored z');
    const archive = join(fixtureRoot(), 'full.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', root, '.'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    return { archive, root };
  }
  it.each(['save', 'install'])('B2: preserves the original data and identifies the phase when %s fails', (phase) => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', backupShapedArchive().archive], {
      env: { KODA_DEPLOY_HARNESS_FAIL_MOVE: phase },
      seedVolume: (dir) => {
        chmodSync(dir, 0o700);
        writeFileSync(join(dir, 'a'), 'original a');
        writeFileSync(join(dir, 'z'), 'original z');
      },
    });

    expect(run.status).not.toBe(0);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
    const previous = join(run.dataDir, '.koda-restore-previous');
    expect(readFileSync(join(previous, 'entries/a'), 'utf8')).toBe('original a');
    expect(readFileSync(join(previous, 'root-metadata'), 'utf8').trim().split(' ').at(-1)).toBe('700');
    expect(existsSync(join(previous, 'installing'))).toBe(phase === 'install');
    if (phase === 'save') {
      expect(readFileSync(join(run.dataDir, 'z'), 'utf8')).toBe('original z');
      expect(existsSync(join(run.dataDir, 'a'))).toBe(false);
    } else {
      expect(readFileSync(join(previous, 'entries/z'), 'utf8')).toBe('original z');
      expect(readFileSync(join(run.dataDir, 'a'), 'utf8')).toBe('restored a');
      expect(existsSync(join(run.dataDir, 'z'))).toBe(false);
    }
    expect(run.output).toContain('Keep the services stopped');
    const lock = join(run.dir, '.harness', 'koda-rollback-lock-koda-local_koda_data');
    expect(existsSync(lock)).toBe(true);
    const contender = run.rerun(['v0.4.0']);
    expect(contender.status).toBe(1);
    expect(contender.output).toContain('Could not acquire rollback lock');
    expect(contender.dockerCalls.some((call) => call.argv.includes('stop') || call.argv.includes('up'))).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });
  it('B14: protects the winning restore from a different project sharing its resolved volume', () => {
    const { archive } = backupShapedArchive();
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive], {
      env: { KODA_DEPLOY_HARNESS_COMPETE: archive, KODA_DEPLOY_HARNESS_VOLUME_NAME: 'shared-data' },
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain('Contender exit: 1');
    expect(run.output).toContain('Could not acquire rollback lock');
    expect(run.dockerCalls.filter((call) => call.argv[0] === 'create').map((call) => call.argv[2]))
      .toEqual(['koda-rollback-lock-shared-data', 'koda-rollback-lock-shared-data']);
    expect(run.dockerCalls.filter((call) => call.argv.includes('stop'))).toHaveLength(1);
    expect(restoreRuns(run.dockerCalls)).toHaveLength(1);
    const restart = run.dockerCalls.findIndex((call) => call.argv.includes('up'));
    expect(restart).toBeGreaterThanOrEqual(0);
    expect(run.dockerCalls.findIndex((call) => call.argv[0] === 'rm')).toBeGreaterThan(restart);
    expect(volumeEntries(run)).toEqual(['a', 'z']);
    expect(readFileSync(join(run.dataDir, 'z'), 'utf8')).toBe('restored z');
  });
  it('B16: applies the archived root owner and mode, not the live root metadata', () => {
    const { archive, root } = backupShapedArchive();
    const live = statSync(root);
    // The fixture declares the ownership its archive records — what `tar -p --numeric-owner` applies on
    // extraction — and starts the live volume on a different owner and mode. A restore that skips the `chown`
    // keeps the live owner, and one that skips the `chmod` keeps the live mode, so either mutant fails.
    const archivedOwner = `${live.uid + 1000}:${live.gid + 1000}`;
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive], {
      seedVolume: (dir) => {
        chmodSync(dir, 0o700);
        writeFileSync(join(dir, '..', 'live-owner'), `${live.uid}:${live.gid}\n`);
        writeFileSync(join(dir, '..', 'archive-owner'), `${archivedOwner}\n`);
      },
    });
    expect(run.status).toBe(0);
    expect(statSync(run.dataDir).mode & 0o7777).toBe(0o750);
    expect(readFileSync(join(run.dir, '.harness', 'live-owner'), 'utf8').trim()).toBe(archivedOwner);
  });
  it('B16: preserves the volume root metadata when there is no root archive entry', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      seedVolume: (dir) => chmodSync(dir, 0o711),
    });
    expect(run.status).toBe(0);
    expect(statSync(run.dataDir).mode & 0o777).toBe(0o711);
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
    const [install] = restoreRuns(run.dockerCalls);
    // The container only sees the mounted directory, so mounting the directory that holds the symlink
    // would hide its target. The script copies the archive into a staging directory and mounts that.
    const stage = mountSource(install);
    expect(stage).not.toBe(run.dir);
    expect(stage.startsWith(run.dir)).toBe(true);
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
  it('refuses to replace a shared volume while another project still has a writable mount', () => {
    const original = 'KODA_VERSION=v0.4.2\n';
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      envFile: original,
      env: { KODA_DEPLOY_HARNESS_VOLUME_NAME: 'shared-data', KODA_DEPLOY_HARNESS_MOUNT_MODE: 'rw' },
      seedVolume: (dir) => writeFileSync(join(dir, 'keep'), 'live data'),
    });

    expect(run.status).toBe(1);
    expect(run.output).toContain('/other-project-api-1');
    expect(run.output).toContain('shared-data');
    const stop = run.dockerCalls.findIndex((call) => call.argv.includes('stop'));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(run.dockerCalls.findIndex((call) => call.argv[0] === 'ps')).toBeGreaterThan(stop);
    expect(restoreRuns(run.dockerCalls)).toEqual([]);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
    expect(volumeEntries(run)).toEqual(['keep']);
    expect(readFileSync(join(run.dataDir, 'keep'), 'utf8')).toBe('live data');
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe(original);
    expect(existsSync(join(run.dir, '.harness', 'koda-rollback-lock-shared-data'))).toBe(false);
  });
  it('allows restoring when the remaining mount is read-only', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      env: { KODA_DEPLOY_HARNESS_MOUNT_MODE: 'ro' },
    });
    expect(run.status).toBe(0);
    expect(run.dockerCalls.some((call) => call.argv.includes('inspect'))).toBe(true);
    expect(restoreRuns(run.dockerCalls)).toHaveLength(1);
  });
  it.each(['ps --no-trunc', 'container inspect'])('refuses to restore if the writer check fails: %s', (failOn) => {
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      docker: { failOn: [failOn] },
      env: { KODA_DEPLOY_HARNESS_MOUNT_MODE: 'rw' },
    });
    expect(run.status).toBe(1);
    expect(restoreRuns(run.dockerCalls)).toEqual([]);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(false);
  });
  it('F1: keeps a backup file name with command separators out of the container command', () => {
    const archive = validArchive('backup.tar.gz;id');
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', archive]);

    const install = restoreRuns(run.dockerCalls)[0];
    expect(install.argv.slice(-2)).toEqual(['koda-restore', 'koda-restore.tar.gz']);
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
  it.each([false, true])('B17: preserves multiline values byte for byte (version assignment: %s)', (present) => {
    const multiline = "UNRELATED: 'hello\r\nKODA_VERSION: example\r\nexport KODA_VERSION = example\r\nworld'\r\n";
    const doubleQuoted = 'OTHER="start\\"escaped\nKODA_VERSION=example\nend"\n';
    const original = multiline + doubleQuoted + (present ? 'export KODA_VERSION : old\n' : '');
    const run = runDeployScript('rollback.sh', ['v0.4.1'], { envFile: original, envFileMode: 0o600 });
    expect(run.status).toBe(0);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe(multiline + doubleQuoted + 'KODA_VERSION=v0.4.1\n');
    expect(statSync(join(run.dir, '.env')).mode & 0o777).toBe(0o600);
  });
  it.each(['"', "'"])('preserves a quoted value ending with two backslashes (%s)', (quote) => {
    const unrelated = `OTHER=${quote}value${'\\'.repeat(2)}${quote}\n`;
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      envFile: unrelated + 'KODA_VERSION=v0.4.2\n', envFileMode: 0o600,
    });
    expect(run.status).toBe(0);
    expect(restoreRuns(run.dockerCalls)).toHaveLength(1);
    expect(run.dockerCalls.some((call) => call.argv.includes('up'))).toBe(true);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe(unrelated + 'KODA_VERSION=v0.4.1\n');
    expect(statSync(join(run.dir, '.env')).mode & 0o777).toBe(0o600);
  });
  it('validates the staged .env with Compose before stopping or restoring', () => {
    const original = 'KODA_VERSION=v0.4.2\n';
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      envFile: original,
      docker: { failOn: ['--env-file /.env.tmp.'] },
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('Could not validate the staged .env');
    expect(run.dockerCalls.some((call) => ['stop', 'run', 'up'].some((verb) => call.argv.includes(verb)))).toBe(false);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe(original);
    expect(readdirSync(run.dir).some((entry) => entry.startsWith('.env.tmp.'))).toBe(false);
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
  it('B6: rewrites a later colon-style version assignment with no shell override', () => {
    // Compose accepts `KEY: value` in an environment file. A later assignment wins, so one left behind would
    // undo the persisted target on the next deploy or rollback (review B6).
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: 'POSTGRES_PASSWORD=pw\nKODA_VERSION: v0.9.0\n',
    });

    expect(run.status).toBe(0);
    expect(envLines(run)).toEqual(['POSTGRES_PASSWORD=pw', 'KODA_VERSION=v0.4.1']);
    expect(run.dockerCalls.find((call) => call.argv.includes('up'))?.kodaVersion).toBe('v0.4.1');
  });
  it('B17: replaces a BOM-prefixed first-line version assignment instead of appending after it', () => {
    // A BOM hides the first assignment from the anchored match, so the old version would stay on line 1 and the
    // target would be appended at the end: every setting in between would still interpolate the old one.
    const bom = '\uFEFF';
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: `${bom}KODA_VERSION=v0.9.0\nOLLAMA_BASE_URL=http://ollama:\${KODA_VERSION}\n`,
    });

    expect(run.status).toBe(0);
    // One assignment, in place, without the BOM, and the unrelated line byte for byte.
    expect(readFileSync(join(run.dir, '.env'), 'utf8'))
      .toBe('KODA_VERSION=v0.4.1\nOLLAMA_BASE_URL=http://ollama:${KODA_VERSION}\n');
    expect(run.dockerCalls.find((call) => call.argv.includes('up'))?.kodaVersion).toBe('v0.4.1');
  });
  it('B1: refuses before stopping anything when the configuration lives in COMPOSE_ENV_FILES and there is no .env', () => {
    // The scripts can only persist the version into a local `.env`, and `deploy.sh` and `backup-db.sh` pin that
    // file once it exists. A deployment configured only through `COMPOSE_ENV_FILES` would change project and
    // volume on its next run — and a later restore could replace another project's volume — so nothing is
    // copied and nothing is stopped (review rollback.sh:289).
    const configFile = join(fixtureRoot(), 'compose-env');
    writeFileSync(configFile, 'COMPOSE_PROJECT_NAME=koda-staging\nPOSTGRES_PASSWORD=pw\n');
    const run = runDeployScript('rollback.sh', ['v0.4.1', '--restore-db', validArchive()], {
      env: { COMPOSE_ENV_FILES: configFile },
    });

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`No ${join(run.dir, '.env')}, but COMPOSE_ENV_FILES is set`);
    expect(run.output).toContain(join(run.dir, '.env'));
    // Nothing was resolved, pulled, locked, stopped or restored, and no `.env` was created.
    expect(run.dockerCalls).toEqual([]);
    expect(existsSync(join(run.dir, '.env'))).toBe(false);
  });
  it('B17: refuses a .env whose setting interpolates the version before the assignment', () => {
    // The identity check cannot see it: `${KODA_VERSION:-latest}` on a line before the appended assignment renders
    // the target for the restart, where the shell override is exported, and the fallback once only the file is
    // read — with the same project, volume and API image (review rollback.sh:293).
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: 'JWT_EXPIRES_IN=${KODA_VERSION:-latest}\n',
      env: { KODA_DEPLOY_HARNESS_INTERPOLATE: 'JWT_EXPIRES_IN' },
    });

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('on its own it would not resolve the same configuration');
    // Refused before the lock and the stop, and the deployment's own file is untouched.
    expect(run.dockerCalls.filter(({ argv }) => argv[0] === 'create' || argv.includes('stop'))).toEqual([]);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe('JWT_EXPIRES_IN=${KODA_VERSION:-latest}\n');
  });
  it('B17: keeps a deployment whose settings do not interpolate the version', () => {
    const run = runDeployScript('rollback.sh', ['v0.4.1'], {
      envFile: 'JWT_EXPIRES_IN=15m\n',
      env: { KODA_DEPLOY_HARNESS_INTERPOLATE: 'JWT_EXPIRES_IN' },
    });

    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe('JWT_EXPIRES_IN=15m\nKODA_VERSION=v0.4.1\n');
  });
});
