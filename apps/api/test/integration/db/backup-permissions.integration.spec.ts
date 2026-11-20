/**
 * The shipped `deployments/example/backup-db.sh`, run against a disposable Docker Compose fixture.
 *
 * The script resolves `docker-compose.yml`, `.env` and `backups/` next to itself, so the fixture copies it
 * into a private temp directory together with a synthetic Compose file and environment file. Every
 * `docker` call the fixture makes pins an explicit, unique project name and its own environment file, and
 * the script's child process gets a controlled environment: an inherited `DATABASE_URL`,
 * `KODA_TEST_DATABASE_URL` or `COMPOSE_PROJECT_NAME` never decides which services a call addresses.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/db/backup-permissions.integration.spec.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { canRunDbTests } from '../../helpers/test-environment';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 900_000 });

const SHIPPED_SCRIPT = resolve(__dirname, '../../../../../deployments/example/backup-db.sh');
const POSTGRES_USER = 'koda';
const POSTGRES_DB = 'koda';
const POSTGRES_PASSWORD = 'synthetic-postgres-password';
/** Ownership the synthetic volume files carry: numeric ids no name lookup on the host can resolve. */
const SOURCE_UID = 1234;
const SOURCE_GID = 5678;
const LANCEDB_CONTENT = 'synthetic-lancedb-entry';
const SOURCE_CONTENT = 'synthetic source file';
/** A row the synthetic database holds, so the dump can be shown to contain the fixture. */
const SENTINEL = 'synthetic-backup-sentinel';
const DUMP_COMPLETE_LINE = '-- PostgreSQL database dump complete';

// The real Docker/PostgreSQL suites only run on an opted-in host.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

interface BackupFixture {
  /** The private fixture directory the copied script resolves its sibling files in. */
  work: string;
  project: string;
  backupDir: string;
  status: number;
  output: string;
  /** What this run could check about ownership, decided before the run and reported with the artifacts. */
  ownership: OwnershipVerdict;
  sqlGz?: string;
  dataTarGz?: string;
}

type OwnershipVerdict = 'checked' | 'unexercised' | 'unavailable';

/** Only what a Compose CLI needs: inherited database URLs and project names must not reach a fixture call. */
function controlledEnv(work: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work };
}

function compose(work: string, project: string, args: string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--env-file', join(work, '.env'), '-f', join(work, 'docker-compose.yml'), '-p', project, ...args],
    { cwd: work, env: controlledEnv(work), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/**
 * A manifest shaped like the shipped one for the two services the backup uses: a postgres service it dumps
 * and an api service whose `/data` is the project's data volume. `name` and the environment file agree, so
 * the unique project name holds whichever of the two Compose reads first. Both services use the PostgreSQL
 * image the rest of the suite already has locally — it carries `sh` and GNU `tar`, which is all the archive
 * step needs, and a fixture that had to reach a registry would fail on an offline host for the wrong reason.
 */
function composeManifest(project: string): string {
  return `name: ${project}
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 1s
      timeout: 3s
      retries: 60
  api:
    image: postgres:16
    entrypoint: ["/bin/sh"]
    command: ["-c", "sleep 600"]
    volumes:
      - koda_data:/data
volumes:
  koda_data:
`;
}

/** Rows the dump has to contain, created through the fixture's own postgres service. */
function seedDatabase(work: string, project: string): void {
  compose(work, project, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    POSTGRES_USER,
    '-d',
    POSTGRES_DB,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `create table backup_fixture (id integer primary key, note text not null); insert into backup_fixture values (1, '${SENTINEL}');`,
  ]);
}

/**
 * Files in the data volume owned by ids that no host account has: the archive has to carry those numbers in
 * its headers, which is what makes the copy faithful on a host whose users differ from the container's.
 */
function seedVolume(work: string, project: string): void {
  const script = [
    'mkdir -p /data/lancedb /data/notes',
    `printf '%s' '${LANCEDB_CONTENT}' > /data/lancedb/entries.jsonl`,
    `printf '%s' '${SOURCE_CONTENT}' > /data/notes/source.txt`,
    `chown -R ${SOURCE_UID}:${SOURCE_GID} /data`,
    'chmod 0640 /data/lancedb/entries.jsonl',
  ].join(' && ');
  compose(work, project, [
    'run',
    '-T',
    '--rm',
    '--no-deps',
    '--user',
    'root',
    '--entrypoint',
    'sh',
    'api',
    '-c',
    script,
  ]);
}

/** Runs the copied script the way an operator's `umask 022` shell would, then collects what it published. */
function runShippedScript(
  work: string,
): Pick<BackupFixture, 'status' | 'output' | 'sqlGz' | 'dataTarGz'> {
  const result = spawnSync('/bin/sh', ['-c', 'umask 022; exec /bin/bash "$@"', 'sh', join(work, 'backup-db.sh')], {
    cwd: work,
    env: controlledEnv(work),
    encoding: 'utf8',
    timeout: 600_000,
  });
  const backupDir = join(work, 'backups');
  const names = existsSync(backupDir) ? readdirSync(backupDir).sort() : [];
  const sqlName = names.find((name) => /^koda-db-.+\.sql\.gz$/.test(name));
  const dataName = names.find((name) => /^koda_data-.+\.tar\.gz$/.test(name));
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    ...(sqlName === undefined ? {} : { sqlGz: join(backupDir, sqlName) }),
    ...(dataName === undefined ? {} : { dataTarGz: join(backupDir, dataName) }),
  };
}

/** An artifact the script was supposed to publish; a missing one fails the test with the run's output. */
function requiredArtifact(path: string | undefined, label: string, fixture: BackupFixture): string {
  if (path === undefined) {
    throw new Error(`the script published no ${label}\n${fixture.output}`);
  }
  return path;
}

function createFixture(work: string, project: string): BackupFixture {
  cpSync(SHIPPED_SCRIPT, join(work, 'backup-db.sh'));
  chmodSync(join(work, 'backup-db.sh'), 0o755);
  writeFileSync(join(work, 'docker-compose.yml'), composeManifest(project));
  writeFileSync(join(work, '.env'), `COMPOSE_PROJECT_NAME=${project}\n`);

  compose(work, project, ['up', '-d', '--wait', 'postgres']);
  seedDatabase(work, project);
  seedVolume(work, project);
  const run = runShippedScript(work);
  const ownership = ownershipVerdict(hostUid());
  if (ownership !== 'checked') {
    // Stated with the run's own result: on a root-only runner the owner check proves nothing, and saying so
    // is better than a green assertion that cannot fail.
    console.warn(`⚠️  backup artifact ownership control is ${ownership} on this host (uid ${String(hostUid())})`);
  }
  return { work, project, backupDir: join(work, 'backups'), ownership, ...run };
}

/** Removes the fixture's own containers, its volume and its files, and nothing else. */
function teardown(work: string, project: string): void {
  try {
    if (!existsSync(join(work, 'docker-compose.yml'))) return;
    const down = spawnSync(
      'docker',
      ['compose', '--env-file', join(work, '.env'), '-f', join(work, 'docker-compose.yml'), '-p', project, 'down', '-v', '--remove-orphans', '-t', '0'],
      { cwd: work, env: controlledEnv(work), encoding: 'utf8' },
    );
    if (down.status !== 0) {
      console.warn(`⚠️  could not remove the ${project} fixture: ${down.stderr}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** The invoking host account, when the platform has one (Windows does not). */
function hostUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Root owns everything it creates, so comparing a file's owner to the invoking uid proves nothing there:
 * that run reports the ownership control as unexercised and still checks modes, readability and content.
 */
function ownershipVerdict(uid: number | undefined): OwnershipVerdict {
  if (uid === undefined) return 'unavailable';
  return uid === 0 ? 'unexercised' : 'checked';
}

interface TarEntry {
  name: string;
  uid: number;
  gid: number;
  size: number;
}

function octal(field: Buffer): number {
  const text = field.toString('latin1').replace(/[\0 ]+$/, '').trim();
  return text === '' ? 0 : parseInt(text, 8);
}

/** The ustar headers of an uncompressed archive, in order. Content is skipped by the header's size. */
function tarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    entries.push({
      name: header.subarray(0, 100).toString('latin1').replace(/\0.*$/, ''),
      uid: octal(header.subarray(108, 116)),
      gid: octal(header.subarray(116, 124)),
      size,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describeIntegration('shipped backup-db.sh against a disposable Compose fixture', () => {
  let work: string;
  let project: string;
  let fixture: BackupFixture;

  beforeAll(() => {
    // The project name is unique per run, so cleanup can be restricted to this case's own resources.
    project = `koda-backup-${randomBytes(4).toString('hex')}`;
    work = mkdtempSync(join(tmpdir(), 'koda-backup-permissions-'));
    try {
      fixture = createFixture(work, project);
    } catch (error) {
      teardown(work, project);
      throw error;
    }
  });

  afterAll(() => {
    if (work === undefined || project === undefined) return;
    teardown(work, project);
  });

  it('AC-8: leaves the backups directory 0700 and both artifacts 0600 under the operator umask', () => {
    expect(fixture.output).toContain('✅ Backup complete');
    expect(fixture.status).toBe(0);
    expect(modeOf(fixture.backupDir)).toBe(0o700);
    expect(modeOf(requiredArtifact(fixture.sqlGz, 'SQL dump', fixture))).toBe(0o600);
    expect(modeOf(requiredArtifact(fixture.dataTarGz, 'data volume archive', fixture))).toBe(0o600);
  });

  it('AC-9: the invoking host user owns and can read both artifacts', () => {
    expect(fixture.status).toBe(0);
    const sql = requiredArtifact(fixture.sqlGz, 'SQL dump', fixture);
    const data = requiredArtifact(fixture.dataTarGz, 'data volume archive', fixture);
    expect(fixture.ownership).toBe(ownershipVerdict(hostUid()));
    if (fixture.ownership === 'checked') {
      // The regression this story fixes: a root container writing a bind mount left the archive owned by
      // root, so the operator could neither read nor restore it on Linux.
      expect(statSync(sql).uid).toBe(hostUid());
      expect(statSync(data).uid).toBe(hostUid());
    }
    expect(readFileSync(sql).length).toBeGreaterThan(0);
    expect(readFileSync(data).length).toBeGreaterThan(0);
  });

  it('AC-10: reports ownership control as unexercised on a root-only host and still runs the other checks', () => {
    // The report the run states for each kind of host, and the checks that run regardless of which one it is.
    expect(ownershipVerdict(0)).toBe('unexercised');
    expect(ownershipVerdict(501)).toBe('checked');
    expect(ownershipVerdict(undefined)).toBe('unavailable');
    expect(['checked', 'unexercised', 'unavailable']).toContain(fixture.ownership);

    expect(fixture.status).toBe(0);
    const sql = requiredArtifact(fixture.sqlGz, 'SQL dump', fixture);
    expect(modeOf(fixture.backupDir)).toBe(0o700);
    expect(modeOf(sql)).toBe(0o600);
    expect(readFileSync(sql).length).toBeGreaterThan(0);
    expect(gunzipSync(readFileSync(sql)).toString('utf8')).toContain(SENTINEL);
  });

  it('AC-11: carries the synthetic files’ numeric uid/gid in the tar headers and extracts to the same bytes', () => {
    expect(fixture.status).toBe(0);
    const data = requiredArtifact(fixture.dataTarGz, 'data volume archive', fixture);
    const entries = tarEntries(gunzipSync(readFileSync(data)));
    const lancedb = entries.filter((entry) => entry.name.endsWith('lancedb/entries.jsonl'));
    const notes = entries.filter((entry) => entry.name.endsWith('notes/source.txt'));

    expect(lancedb).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(lancedb[0]?.uid).toBe(SOURCE_UID);
    expect(lancedb[0]?.gid).toBe(SOURCE_GID);
    expect(notes[0]?.uid).toBe(SOURCE_UID);
    expect(notes[0]?.gid).toBe(SOURCE_GID);

    // Extract without letting the host tar reproduce ids it has no account for: the header check above is
    // what proves ownership survived, this proves the bytes did.
    const extracted = join(fixture.work, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', data, '-C', extracted, '--no-same-owner']);
    expect(readFileSync(join(extracted, 'lancedb', 'entries.jsonl'), 'utf8')).toBe(LANCEDB_CONTENT);
    expect(readFileSync(join(extracted, 'notes', 'source.txt'), 'utf8')).toBe(SOURCE_CONTENT);
  });

  it('AC-12: decompresses the SQL gzip to a complete dump containing the synthetic database fixture', () => {
    expect(fixture.status).toBe(0);
    const sql = gunzipSync(readFileSync(requiredArtifact(fixture.sqlGz, 'SQL dump', fixture))).toString('utf8');

    expect(sql.split('\n')).toContain(DUMP_COMPLETE_LINE);
    expect(sql).toContain('CREATE TABLE public.backup_fixture');
    expect(sql).toContain(SENTINEL);
  });
});
