import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { vi } from 'vitest';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  DEFAULT_PG_DUMP,
  cleanupDeployScriptRuns,
  runDeployScript,
  type DockerCall,
  type ScriptRun,
} from './helpers/deploy-script-harness';

vi.setConfig({ testTimeout: 30_000 });

const DUMP_COMPLETE_LINE = '-- PostgreSQL database dump complete';
const INCOMPLETE_PG_DUMP = ['--', '-- PostgreSQL database dump', '--', ''].join('\n');
/** The bytes the stubbed container streams for a data volume archive. */
const SYNTHETIC_ARCHIVE = 'SYNTHETIC-VOLUME-ARCHIVE-BYTES\n';
/** What the harness's umask-022 operator shell looks like: the mode the story's regression starts from. */
const OPERATOR_UMASK = '022';

afterEach(() => {
  cleanupDeployScriptRuns();
});

function backupsDir(run: ScriptRun): string {
  return join(run.dir, 'backups');
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Every file in the script's own backups directory, under its published or temporary name. */
function backupEntries(run: ScriptRun): string[] {
  return readdirSync(backupsDir(run)).sort();
}

function dumpFiles(run: ScriptRun): string[] {
  return backupEntries(run).filter((name) => /^koda-db-.+\.sql\.gz$/.test(name));
}

/** Restore-ready volume archives. `koda_data-<stamp>.tar.gz`, never the dot-prefixed partial. */
function publishedArchives(run: ScriptRun): string[] {
  return backupEntries(run).filter((name) => /^koda_data-.+\.tar\.gz$/.test(name));
}

function partialArchives(run: ScriptRun): string[] {
  return backupEntries(run).filter((name) => /^\.koda_data-.+\.tar\.gz\.partial$/.test(name));
}

/**
 * The modes the `docker` stub observed while a streaming call was running: the state of the script's
 * artifacts at the moment that call wrote, not only after the script finished.
 */
function moment(run: ScriptRun, name: 'dump-moment' | 'archive-moment'): Record<string, string> {
  const file = join(run.dir, '.harness', name);
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const separator = line.indexOf(' ');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

/**
 * What the `gzip` shim saw while it decompressed the dump: the kind of its stdout (a pipe, or a regular
 * file it was redirected into) and every entry the script's `backups/` directory held at that instant.
 */
interface VerifyMoment {
  stdout: 'file' | 'pipe';
  entries: { name: string; kind: 'gzip' | 'plaintext'; mode: string }[];
}

function verifyMoment(run: ScriptRun): VerifyMoment | undefined {
  const file = join(run.dir, '.harness', 'verify-moment');
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  const header = lines.shift() ?? '';
  return {
    stdout: header === 'stdout file' ? 'file' : 'pipe',
    entries: lines.map((line) => {
      const [name = '', kind = '', mode = ''] = line.split(' ');
      return { name, kind: kind === 'gzip' ? 'gzip' : 'plaintext', mode };
    }),
  };
}

/**
 * What the deployment directory held while the verifier decompressed the dump: the `gzip` shim lists `run.dir`
 * itself (`.`) and every entry beside it, with `backups/` and the harness's own `.harness/` pruned. `undefined`
 * when the run never decompressed the dump.
 *
 * The listing is taken while the shim is still the pipeline's decompressor, so a plaintext copy a downstream
 * command writes outside `backups/` is on record even when a later command deletes it before the script exits.
 *
 * This covers the deployment directory only. A copy the verifier writes somewhere else — `mktemp`,
 * `${TMPDIR:-/tmp}`, which is where a temporary file normally goes — is what `tempDirEntries` reads; a
 * hard-coded path elsewhere on the host (a literal `/tmp/...`, `~`) is out of reach of any listing probe, so
 * the guarantee these cases give is "the deployment directory and the script's own temp directory stay
 * clean", not "no plaintext copy anywhere on the machine" (koda #497).
 */
function verifyTree(run: ScriptRun): string[] | undefined {
  const file = join(run.dir, '.harness', 'verify-tree');
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    // The probe lists the directory with `find .`, so everything below it is printed as `./name`.
    .map((line) => (line.startsWith('./') ? line.slice('./'.length) : line));
  return lines.length === 0 ? undefined : lines;
}

/** The entries the harness itself puts beside the scripts: the deployment a run starts from, and nothing else. */
const DEPLOYMENT_ENTRIES = ['.', 'backup-db.sh', 'deploy.sh', 'docker-compose.yml', 'rollback.sh'];

/**
 * What the temp directory the script was given (`run.tmpDir`) held while the verifier decompressed the dump:
 * the `gzip` shim lists it at the same moment it lists the deployment directory. `undefined` when the probe
 * never ran, `[]` when it ran and the directory was clean.
 *
 * A copy written here is outside the deployment directory, so `verifyTree` cannot see it; `mktemp` and
 * `${TMPDIR:-/tmp}` both land here because the harness owns the script's `TMPDIR`. Several decompressions
 * each append their own block, and the union is what the directory held at any point while the verifier ran.
 */
function tempDirEntries(run: ScriptRun): string[] | undefined {
  const file = join(run.dir, '.harness', 'verify-tmp');
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  // The marker keeps "the probe ran and saw nothing" apart from "the probe never ran".
  if (lines[0] !== 'listing') return undefined;
  return lines
    .slice(1)
    .filter((line) => line !== 'listing')
    .map((line) => (line.startsWith('./') ? line.slice('./'.length) : line));
}

/** Entries in the deployment directory that no run put there: a file the script created beside its backups. */
function entriesCreatedBesideBackups(run: ScriptRun): string[] {
  return (verifyTree(run) ?? []).filter((entry) => !DEPLOYMENT_ENTRIES.includes(entry));
}

function callIndex(calls: DockerCall[], predicate: (argv: string[]) => boolean): number {
  return calls.findIndex((call) => predicate(call.argv));
}

function isPgDumpCall(argv: string[]): boolean {
  return argv.some((argument) => argument.includes('pg_dump'));
}

function pgDumpCall(run: ScriptRun): DockerCall | undefined {
  return run.dockerCalls.find((call) => isPgDumpCall(call.argv));
}

function archiveCall(run: ScriptRun): DockerCall | undefined {
  return run.dockerCalls.find((call) => call.argv.includes('-czf') && call.argv.includes('-'));
}

function only(names: string[]): string {
  expect(names).toHaveLength(1);
  return names[0] as string;
}

describe('backup-db.sh', () => {
  it('AC-1: creates a new backups directory 0700 before the first dump output', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(run.status).toBe(0);
    expect(modeOf(backupsDir(run))).toBe(0o700);
    // The stub recorded the directory mode while pg_dump was running, i.e. before its first byte was
    // accepted: the redirect that creates the dump file ran against an already-private directory.
    expect(pgDumpCall(run)?.backupsDirMode).toBe('700');
    expect(moment(run, 'dump-moment').backups).toBe('700');
  });

  it('AC-1: tightens an existing 0755 backups directory to 0700 before the first dump output', () => {
    // `mkdir -p` keeps the mode of a directory an earlier umask-022 run created.
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK, backupsDirMode: 0o755 });

    expect(run.status).toBe(0);
    expect(modeOf(backupsDir(run))).toBe(0o700);
    expect(pgDumpCall(run)?.backupsDirMode).toBe('700');
    expect(moment(run, 'dump-moment').backups).toBe('700');
  });

  it('AC-2: creates the compressed dump and the partial archive owner-only from creation', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(run.status).toBe(0);
    const dump = only(dumpFiles(run));
    expect(modeOf(join(backupsDir(run), dump))).toBe(0o600);
    // Both artifacts were already private while they were being written, not chmod-ed afterwards.
    expect(moment(run, 'dump-moment')[dump]).toBe('600');
    const partialName = only(Object.keys(moment(run, 'archive-moment')));
    expect(partialName).toMatch(/^\.koda_data-.+\.tar\.gz\.partial$/);
    expect(moment(run, 'archive-moment')[partialName]).toBe('600');
    // The published archive keeps the mode the host created its partial with.
    expect(modeOf(join(backupsDir(run), only(publishedArchives(run))))).toBe(0o600);
  });

  it('AC-2: verifies the SQL gzip without writing a plaintext copy of the dump', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    // What the verifier itself saw while it read the dump: the decompressed stream went into the pipe that
    // greps it, and the only thing in the backups directory was the compressed dump. A verifier that wrote
    // the plaintext out and deleted it again fails here, not only in a listing taken after it cleaned up.
    const dump = only(dumpFiles(run));
    const verify = verifyMoment(run);
    expect(verify?.stdout).toBe('pipe');
    expect(verify?.entries).toEqual([{ name: dump, kind: 'gzip', mode: '600' }]);

    expect(run.status).toBe(0);
    // Nothing plaintext survives either: exactly the two compressed artifacts, under no other name.
    expect(backupEntries(run)).toHaveLength(2);
    for (const name of backupEntries(run)) {
      expect(name).toMatch(/\.(sql|tar)\.gz$/);
      expect(name).not.toMatch(/\.sql$/);
    }
    expect(dumpFiles(run)).toHaveLength(1);
    expect(publishedArchives(run)).toHaveLength(1);
  });

  it('AC-2: writes nothing beside its backups directory while it verifies the dump', () => {
    // The case above inspects what the verifier streamed and what `backups/` held at that instant; this one
    // reads the deployment directory itself while the dump is being verified, so a verifier that stores the
    // plaintext copy somewhere else — under any name — has nowhere to hide.
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(run.status).toBe(0);
    // The probe ran and saw the deployment it starts from, so the comparison below is a reading and not an
    // empty file.
    expect(verifyTree(run)).toEqual(DEPLOYMENT_ENTRIES);
    expect(entriesCreatedBesideBackups(run)).toEqual([]);
  });

  it('AC-2: the verify probe catches a plaintext copy written beside the script and deleted again', () => {
    // The guarantee above, validated against the mutation it exists to catch: `tee` puts the decompressed dump
    // beside the script and the very next command deletes it. The run still succeeds and nothing plaintext is
    // left on disk, so neither the gzip shim's stdout kind nor a listing of backups/ taken afterwards sees it —
    // the deployment directory listed while the pipeline runs does.
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      editScript: (source) =>
        source.replace(
          'gzip -dc "$DB_BACKUP_FILE" | grep -F -x -- "$DUMP_COMPLETE_LINE" >/dev/null || report_failed_dump',
          'gzip -dc "$DB_BACKUP_FILE" | tee "$SCRIPT_DIR/verifier-plaintext.sql" | grep -F -x -- "$DUMP_COMPLETE_LINE" >/dev/null || report_failed_dump\nrm -f "$SCRIPT_DIR/verifier-plaintext.sql"',
        ),
    });

    expect(run.status).toBe(0);
    // The copy is gone from disk by the time the script exits, which is why the earlier cases could not see it.
    expect(existsSync(join(run.dir, 'verifier-plaintext.sql'))).toBe(false);
    expect(only(dumpFiles(run))).toMatch(/^koda-db-.+\.sql\.gz$/);
    expect(entriesCreatedBesideBackups(run)).toEqual(['verifier-plaintext.sql']);
  });

  it('AC-2: writes nothing in the temp directory it was given while it verifies the dump', () => {
    // The deployment directory is not the only place a verifier could keep the plaintext: a temporary copy
    // normally goes to `mktemp` or `${TMPDIR:-/tmp}`, both of which the harness owns for this run, so the same
    // probe lists that directory too (koda #497).
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(run.status).toBe(0);
    // The probe ran (it listed the deployment) and the temp directory stayed empty: the decompressed dump went
    // through the pipe and into no scratch file at all.
    expect(verifyTree(run)).toEqual(DEPLOYMENT_ENTRIES);
    expect(tempDirEntries(run)).toEqual([]);
    expect(readdirSync(run.tmpDir)).toEqual([]);
  });

  it('AC-2: the verify probe catches a plaintext copy written in the temp directory and deleted again', () => {
    // The gap #497 reported: the same mutation as the case above, one directory further out. Listing the
    // deployment directory alone sees nothing here, because the copy never exists there, and the run ends with
    // nothing on disk either — so only the temp directory listed while the pipeline runs catches it.
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      editScript: (source) =>
        source.replace(
          'gzip -dc "$DB_BACKUP_FILE" | grep -F -x -- "$DUMP_COMPLETE_LINE" >/dev/null || report_failed_dump',
          'gzip -dc "$DB_BACKUP_FILE" | tee "${TMPDIR:-/tmp}/verifier-plaintext.sql" | grep -F -x -- "$DUMP_COMPLETE_LINE" >/dev/null || report_failed_dump\nrm -f "${TMPDIR:-/tmp}/verifier-plaintext.sql"',
        ),
    });

    expect(run.status).toBe(0);
    // Nothing survives the script, and nothing was ever beside it: the earlier cases cannot see this copy.
    expect(existsSync(join(run.tmpDir, 'verifier-plaintext.sql'))).toBe(false);
    expect(entriesCreatedBesideBackups(run)).toEqual([]);
    // The temp directory the script was handed is where it landed, and the probe caught it while it existed.
    expect(tempDirEntries(run)).toEqual(['verifier-plaintext.sql']);
  });

  it('AC-3: fails before any pg_dump when a regular file sits where the backups directory belongs', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK, backupsIsFile: true });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain(`❌ Cannot create the backup directory: ${backupsDir(run)}`);
    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBe(-1);
  });

  it('AC-4: accepts a completion marker followed by more than 1 MiB of data under pipefail', () => {
    // A verifier that stops reading at the marker (`grep -q`) kills the decompressor with SIGPIPE and
    // fails under `set -o pipefail`; the entire decompressed stream has to be consumed.
    const pgDump = `${DEFAULT_PG_DUMP}${'x'.repeat(1024 * 1024 + 64)}`;
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK, docker: { pgDump } });

    expect(run.status).toBe(0);
    expect(dumpFiles(run)).toHaveLength(1);
    expect(publishedArchives(run)).toHaveLength(1);
  });

  it('AC-4: returns nonzero and keeps no accepted dump when the completion marker is missing', () => {
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      docker: { pgDump: INCOMPLETE_PG_DUMP },
    });

    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBeGreaterThanOrEqual(0);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('❌ Postgres dump failed');
    expect(dumpFiles(run)).toEqual([]);
  });

  it('AC-4: rejects a completion marker that is not its own line', () => {
    // The verifier matches the exact line, so a dump whose marker was truncated into another line does not
    // count as complete.
    const pgDump = DEFAULT_PG_DUMP.replace(DUMP_COMPLETE_LINE, `${DUMP_COMPLETE_LINE} was truncated`);
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK, docker: { pgDump } });

    expect(run.status).not.toBe(0);
    expect(dumpFiles(run)).toEqual([]);
  });

  it('AC-5: returns nonzero and keeps no accepted dump when the compressed input is invalid', () => {
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      env: { KODA_DEPLOY_HARNESS_GZIP_CORRUPT: '1' },
    });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('❌ Postgres dump failed');
    expect(dumpFiles(run)).toEqual([]);
  });

  it('AC-5: returns nonzero and keeps no accepted dump when pg_dump failed', () => {
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      docker: { pgDumpExit: 1 },
    });

    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBeGreaterThanOrEqual(0);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('❌ Postgres dump failed');
    expect(dumpFiles(run)).toEqual([]);
  });

  it('AC-6: returns nonzero when the container tar dies after partial stdout', () => {
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      docker: { failOn: ['-czf -'] },
    });

    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBeGreaterThanOrEqual(0);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('❌ Data volume backup failed');
  });

  it('AC-6: removes the partial archive and retains only the verified dump', () => {
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      docker: { failOn: ['-czf -'] },
    });

    expect(partialArchives(run)).toEqual([]);
    expect(publishedArchives(run)).toEqual([]);
    const dump = only(backupEntries(run));
    expect(dump).toMatch(/^koda-db-.+\.sql\.gz$/);
    // The dump it leaves behind is the complete one it verified before the archive step.
    expect(gunzipSync(readFileSync(join(backupsDir(run), dump))).toString('utf8')).toBe(DEFAULT_PG_DUMP);
  });

  it('AC-7: publishes distinct artifact names for two backups started in the same second', () => {
    const clock = '20260101-000000';
    const first = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      env: { KODA_DEPLOY_HARNESS_DATE: clock },
    });
    const second = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      env: { KODA_DEPLOY_HARNESS_DATE: clock },
    });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(backupEntries(first)).toHaveLength(2);
    expect(backupEntries(second)).toHaveLength(2);

    const firstDump = only(dumpFiles(first));
    const secondDump = only(dumpFiles(second));
    const firstArchive = only(publishedArchives(first));
    const secondArchive = only(publishedArchives(second));
    expect(firstDump).toContain(`-${clock}-`);
    expect(secondDump).toContain(`-${clock}-`);
    expect(firstDump).not.toBe(secondDump);
    expect(firstArchive).not.toBe(secondArchive);
  });

  it('starts the postgres service before it dumps', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

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

  it('gzips exactly the dump pg_dump produced into one timestamped file', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(DEFAULT_PG_DUMP.split('\n')).toContain(DUMP_COMPLETE_LINE);
    const dump = only(dumpFiles(run));
    expect(dump).toMatch(/^koda-db-\d{8}-\d{6}-\d+\.sql\.gz$/);
    expect(gunzipSync(readFileSync(join(backupsDir(run), dump))).toString('utf8')).toBe(DEFAULT_PG_DUMP);
  });

  it('streams the archive from the project api container into a host-owned file', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(run.status).toBe(0);
    // No TTY, no bind mount: tar writes its archive to stdout and the host decides where it lands, so the
    // invoking account owns the file even on Linux (a root container writing a bind mount does not).
    expect(archiveCall(run)?.argv).toEqual([
      'compose',
      '-f',
      `${run.dir}/docker-compose.yml`,
      'run',
      '-T',
      '--rm',
      '--no-deps',
      '--user',
      'root',
      '--entrypoint',
      'tar',
      'api',
      '-czf',
      '-',
      '-C',
      '/data',
      '.',
    ]);
    // The host's own redirect wrote the bytes the container streamed, and only the finished file is
    // published under the restore-ready name.
    expect(readFileSync(join(backupsDir(run), only(publishedArchives(run))), 'utf8')).toBe(SYNTHETIC_ARCHIVE);
  });

  it('runs every docker call through the compose plugin', () => {
    const run = runDeployScript('backup-db.sh', [], { umask: OPERATOR_UMASK });

    expect(run.dockerCalls.length).toBeGreaterThan(0);
    for (const call of run.dockerCalls) {
      expect(call.argv[0]).toBe('compose');
    }
  });

  it('stops before dumping when postgres cannot be started', () => {
    const run = runDeployScript('backup-db.sh', [], {
      umask: OPERATOR_UMASK,
      docker: { failOn: ['up -d --wait postgres'] },
    });

    expect(run.status).not.toBe(0);
    expect(callIndex(run.dockerCalls, (argv) => argv.includes('--wait'))).toBeGreaterThanOrEqual(0);
    expect(callIndex(run.dockerCalls, isPgDumpCall)).toBe(-1);
    expect(dumpFiles(run)).toEqual([]);
  });
});
