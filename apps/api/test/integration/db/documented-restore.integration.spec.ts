/**
 * The PostgreSQL recovery procedure documented in `deployments/example/README.md`, run against a disposable
 * PostgreSQL 16 Compose fixture.
 *
 * Nothing here reimplements the runbook: the fixture extracts the README's marked `restore-step-*` blocks, in
 * the order the guide prints them, concatenates them into one Bash script and runs that script. A step that is
 * missing, renamed or reordered from the guide therefore changes what this file executes. The guide keeps the
 * reversal out of that script (a successful restore ends on the restored database); it is marked
 * `restore-reversal` and the fixture runs it as the separate script the guide documents — the inputs block
 * followed by the reversal block — so cutover and reversal are exercised as the two operations they are.
 *
 * The fixture is a synthetic deployment of its own: a unique Compose project, its own environment file, its own
 * named volume and a synthetic API database client (`api`) that derives `DATABASE_URL` from `POSTGRES_DB` the
 * way the shipped manifest does, reads a row from whatever database that setting selects and appends one line
 * per start to a host log. Every procedure run gets a controlled environment, so an inherited `DATABASE_URL`,
 * `KODA_TEST_DATABASE_URL` or `COMPOSE_PROJECT_NAME` can never decide which database or project it addresses.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/db/documented-restore.integration.spec.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { canRunDbTests } from '../../helpers/test-environment';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 1_800_000 });

const README = resolve(__dirname, '../../../../../deployments/example/README.md');
const POSTGRES_USER = 'koda';
const POSTGRES_PASSWORD = 'synthetic-postgres-password';
/** The database the fixture deployment serves before recovery: `POSTGRES_DB` in its environment file. */
const ORIGINAL_DB = 'koda';
/** The table and migration records the backup's baseline is captured from. */
const BASELINE_TABLE = 'restore_probe';
const BASELINE_ROWS = '1';
const BASELINE_MIGRATIONS = '1';
const RESTORED_DB = 'koda_restore_full';
const CONFLICT_DB = 'koda_restore_conflict';
const REFUSED_DB = 'koda_restore_refused';
const BAD_SQL_DB = 'koda_restore_bad_sql';
const INVALID_GZIP_DB = 'koda_restore_invalid_gzip';
const TRUNCATED_GZIP_DB = 'koda_restore_truncated_gzip';
const WRONG_BASELINE_DB = 'koda_restore_baseline';
const SENTINEL_TABLE = 'operator_sentinel';
const REFUSED_SENTINEL = '1,do-not-touch';
const BAD_SQL_SENTINEL = 'sentinel-after-sql-error';
/** The ids the guide's procedure is made of, in the order it documents them. The reversal is not one of them. */
const EXPECTED_STEP_IDS = ['1-inputs', '2-preflight', '3-replay', '4-verify', '5-cutover'];

// The real Docker/PostgreSQL suites only run on an opted-in host.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

interface MarkedStep {
  id: string;
  body: string;
}

/**
 * The guide's executable blocks. `restore-step-<n>-<name>` in the fence's info string is what marks a block as
 * part of the procedure; every other fenced block in the README is documentation and is never run.
 */
function markedSteps(): MarkedStep[] {
  const text = readFileSync(README, 'utf8');
  const pattern = /^```bash restore-step-([0-9]+)-([a-z-]+)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  return [...text.matchAll(pattern)].map((match) => ({
    id: `${match[1] ?? ''}-${match[2] ?? ''}`,
    body: match[3] ?? '',
  }));
}

/**
 * The reversal's block. It is deliberately not a `restore-step-*` block: the guide builds `restore.sh` from the
 * steps alone, because a reversal appended to them would switch the deployment back to the original database at
 * the end of every successful restore. The guide documents `reversal.sh` as the inputs block followed by this
 * block, which is what the fixture assembles below.
 */
function markedReversal(): string {
  const text = readFileSync(README, 'utf8');
  const match = /^```bash restore-reversal[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(text);
  const body = match?.[1];
  if (body === undefined) throw new Error('the guide no longer marks its reversal block as restore-reversal');
  return body;
}

/** Only what a Compose CLI or a procedure step needs: inherited database URLs and project names stay out. */
function controlledEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...extra };
}

function composeArgs(work: string, project: string): string[] {
  return ['compose', '--env-file', join(work, '.env'), '-f', join(work, 'docker-compose.yml'), '-p', project];
}

function compose(work: string, project: string, args: string[]): string {
  return execFileSync('docker', [...composeArgs(work, project), ...args], {
    cwd: work,
    env: controlledEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** One psql call as the configured role: the way an operator inspects a stopped deployment. */
function psql(work: string, project: string, database: string, sql: string): string {
  return compose(work, project, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-tA',
    '-U',
    POSTGRES_USER,
    '-d',
    database,
    '-c',
    sql,
  ]).trim();
}

/**
 * A deployment shaped like the shipped one for the services recovery touches: the postgres service the dump
 * comes from, and an `api` service whose `DATABASE_URL` is derived from `POSTGRES_DB` — the setting the
 * cutover flips — plus the `web` service the cutover recreates alongside it.
 */
function composeManifest(): string {
  return `name: \${COMPOSE_PROJECT_NAME}
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB:-${ORIGINAL_DB}}
    volumes:
      - koda_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d \${POSTGRES_DB:-${ORIGINAL_DB}}"]
      interval: 1s
      timeout: 3s
      retries: 60
    restart: unless-stopped
  api:
    image: postgres:16
    entrypoint: ["/bin/sh", "-c"]
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-${ORIGINAL_DB}}
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-${ORIGINAL_DB}}
      WRITER_LOG: /state/writer-starts.log
    volumes:
      - ./state:/state
    depends_on:
      postgres:
        condition: service_healthy
    command:
      - |
        set -u
        rm -f /state/api-ready
        rows=$$(psql "$$DATABASE_URL" -X -tA -c 'select note from ${BASELINE_TABLE} order by id' 2>/dev/null | paste -sd, -)
        if [ -z "$$rows" ]; then rows="unavailable"; fi
        printf 'start db=%s rows=%s\\n' "$$POSTGRES_DB" "$$rows" >> "$$WRITER_LOG"
        touch /state/api-ready
        exec sleep 900
    healthcheck:
      test: ["CMD-SHELL", "test -f /state/api-ready"]
      interval: 1s
      timeout: 3s
      retries: 60
    restart: unless-stopped
  web:
    image: postgres:16
    entrypoint: ["/bin/sh", "-c", "exec sleep 900"]
    healthcheck:
      test: ["CMD-SHELL", "exit 0"]
      interval: 1s
      timeout: 3s
      retries: 5
    restart: unless-stopped
volumes:
  koda_pg:
    driver: local
`;
}

interface DeploymentState {
  /** The `POSTGRES_DB` value the environment file persists: what the deployment selects on (re)start. */
  persistedDb: string;
  /** Rows the original database holds. */
  originalRows: string;
  /** How many times the synthetic API client has started in total. */
  writerStarts: number;
  /** The writer log itself, oldest line first. */
  writerLines: string[];
}

interface ProcedureRun {
  label: string;
  /** The step ids that were available in the guide when this run was assembled. */
  stepIds: string[];
  status: number;
  output: string;
  persistedDbBefore: string;
  persistedDbAfter: string;
  writerStartsAdded: number;
  writerLinesAdded: string[];
  originalRowsBefore: string;
  originalRowsAfter: string;
}

function persistedDb(work: string): string {
  const lines = readFileSync(join(work, '.env'), 'utf8').split('\n');
  const line = lines.find((candidate) => candidate.startsWith('POSTGRES_DB='));
  return line === undefined ? '' : (line.slice('POSTGRES_DB='.length).trim() ?? '');
}

function writerLines(work: string): string[] {
  const path = join(work, 'state', 'writer-starts.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** Trims the empty-string line psql prints for an empty result set. */
function psqlIn(work: string, project: string, database: string, sql: string): string {
  return psql(work, project, database, sql)
    .split('\n')
    .filter((line) => line !== '')
    .join('\n');
}

function deploymentState(work: string, project: string): DeploymentState {
  const lines = writerLines(work);
  return {
    persistedDb: persistedDb(work),
    originalRows: psqlIn(work, project, ORIGINAL_DB, `select (id::text || ',' || note) from ${BASELINE_TABLE} order by id`),
    writerStarts: lines.length,
    writerLines: lines,
  };
}

function procedureInputs(
  work: string,
  project: string,
  archive: string,
  target: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    KODA_RESTORE_COMPOSE_FILE: join(work, 'docker-compose.yml'),
    KODA_RESTORE_PROJECT: project,
    KODA_RESTORE_ENV_FILE: join(work, '.env'),
    KODA_RESTORE_ROLE: POSTGRES_USER,
    KODA_RESTORE_ARCHIVE: archive,
    KODA_RESTORE_ORIGINAL_DB: ORIGINAL_DB,
    KODA_RESTORE_TARGET_DB: target,
    KODA_RESTORE_BASELINE_TABLE: BASELINE_TABLE,
    KODA_RESTORE_BASELINE_ROWS: BASELINE_ROWS,
    KODA_RESTORE_BASELINE_MIGRATIONS: BASELINE_MIGRATIONS,
    ...overrides,
  };
}

/**
 * Runs the guide's marked blocks as one Bash script, exactly as an operator would, and records what the
 * deployment looked like before and after it: which database the environment file selects, what the original
 * database holds, and whether any application writer started.
 *
 * `extraEnv` is spread into the script's environment after the inputs, so a case can reproduce an operator
 * shell that exports a variable Compose would otherwise interpolate (an inherited `POSTGRES_DB`).
 */
function runProcedure(
  work: string,
  project: string,
  label: string,
  inputs: Record<string, string>,
  extraEnv: Record<string, string> = {},
): ProcedureRun {
  const steps = markedSteps();
  const script = join(work, `procedure-${label}.sh`);
  writeFileSync(script, steps.map((step) => step.body).join('\n'));
  chmodSync(script, 0o755);

  const before = deploymentState(work, project);
  const result = spawnSync('/bin/bash', [script], {
    cwd: work,
    env: controlledEnv({ ...inputs, ...extraEnv }),
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const after = deploymentState(work, project);

  return {
    label,
    stepIds: steps.map((step) => step.id),
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    persistedDbBefore: before.persistedDb,
    persistedDbAfter: after.persistedDb,
    writerStartsAdded: after.writerStarts - before.writerStarts,
    writerLinesAdded: after.writerLines.slice(before.writerLines.length),
    originalRowsBefore: before.originalRows,
    originalRowsAfter: after.originalRows,
  };
}

/**
 * Runs the reversal the way the guide documents it: a script of its own, made of the inputs/helpers block and
 * the `restore-reversal` block. It is never appended to the procedure's script, so a successful restore is not
 * silently undone, and a test that wants a reversal has to ask for one.
 */
function runReversal(
  work: string,
  project: string,
  label: string,
  inputs: Record<string, string>,
  extraEnv: Record<string, string> = {},
): ProcedureRun {
  const steps = markedSteps();
  const inputsBlock = steps.find((step) => step.id === '1-inputs');
  if (inputsBlock === undefined) throw new Error('the guide no longer marks its inputs block as restore-step-1-inputs');
  const script = join(work, `reversal-${label}.sh`);
  writeFileSync(script, `${inputsBlock.body}\n${markedReversal()}`);
  chmodSync(script, 0o755);

  const before = deploymentState(work, project);
  const result = spawnSync('/bin/bash', [script], {
    cwd: work,
    env: controlledEnv({ ...inputs, ...extraEnv }),
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const after = deploymentState(work, project);

  return {
    label,
    stepIds: ['1-inputs', 'reversal'],
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    persistedDbBefore: before.persistedDb,
    persistedDbAfter: after.persistedDb,
    writerStartsAdded: after.writerStarts - before.writerStarts,
    writerLinesAdded: after.writerLines.slice(before.writerLines.length),
    originalRowsBefore: before.originalRows,
    originalRowsAfter: after.originalRows,
  };
}

/** The snapshot the operator captured for a backup: rows written before the incident. */
function seedOriginalDatabase(work: string, project: string): void {
  psqlIn(
    work,
    project,
    ORIGINAL_DB,
    [
      `create table ${BASELINE_TABLE} (id integer primary key, note text not null);`,
      `insert into ${BASELINE_TABLE} (id, note) values (1, 'before');`,
      `create table _prisma_migrations (
         id varchar(36) primary key,
         checksum varchar(64) not null,
         finished_at timestamptz,
         migration_name varchar(255) not null,
         logs text,
         rolled_back_at timestamptz,
         started_at timestamptz not null default now(),
         applied_steps_count integer not null default 0
       );`,
      `insert into _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
         values ('synthetic-migration-0001', 'synthetic-checksum', now(), '20260101000000_init', 1);`,
    ].join('\n'),
  );
}

/**
 * The dump `backup-db.sh` publishes (`koda-db-<ts>.sql.gz`): plain SQL from `pg_dump` as the configured role,
 * gzipped. Taken while the fixture still holds the (1,before) snapshot.
 */
function takeBackup(work: string, project: string, path: string): void {
  const dump = execFileSync(
    'docker',
    [...composeArgs(work, project), 'exec', '-T', 'postgres', 'sh', '-lc', 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"'],
    { cwd: work, env: controlledEnv(), maxBuffer: 64 * 1024 * 1024 },
  );
  mkdirSync(join(work, 'backups'), { recursive: true });
  writeFileSync(path, gzipSync(dump));
}

/** What happens to the original database after the backup: the rows the restore must not resurrect. */
function writeNewerRows(work: string, project: string): void {
  psqlIn(
    work,
    project,
    ORIGINAL_DB,
    `update ${BASELINE_TABLE} set note = 'after' where id = 1;
     insert into ${BASELINE_TABLE} (id, note) values (2, 'new');`,
  );
}

/** Removes the fixture's own containers, volume and files, and nothing else. */
function teardown(work: string, project: string): void {
  try {
    if (!existsSync(join(work, 'docker-compose.yml'))) return;
    const down = spawnSync('docker', [...composeArgs(work, project), 'down', '-v', '--remove-orphans', '-t', '0'], {
      cwd: work,
      env: controlledEnv(),
      encoding: 'utf8',
    });
    if (down.status !== 0) {
      console.warn(`⚠️  could not remove the ${project} fixture: ${down.stderr}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describeIntegration('documented PostgreSQL restore procedure against a disposable Compose fixture', () => {
  let work: string;
  let project: string;
  let archive: string;
  let successRun: ProcedureRun;
  let reversalRun: ProcedureRun;
  let conflictRun: ProcedureRun;
  let conflictReversalRun: ProcedureRun;
  let refusedRun: ProcedureRun;
  let badSqlRun: ProcedureRun;
  let invalidGzipRun: ProcedureRun;
  let truncatedGzipRun: ProcedureRun;
  let wrongBaselineRun: ProcedureRun;

  beforeAll(() => {
    project = `koda-restore-${randomBytes(4).toString('hex')}`;
    work = mkdtempSync(join(tmpdir(), 'koda-documented-restore-'));
    try {
      // The synthetic API client writes its start log and readiness marker into a host directory the
      // container user can write.
      const state = join(work, 'state');
      mkdirSync(state, { recursive: true, mode: 0o777 });
      chmodSync(state, 0o777);

      writeFileSync(join(work, 'docker-compose.yml'), composeManifest());
      writeFileSync(join(work, '.env'), `COMPOSE_PROJECT_NAME=${project}\nPOSTGRES_DB=${ORIGINAL_DB}\n`);

      compose(work, project, ['up', '-d', '--wait', 'postgres']);
      seedOriginalDatabase(work, project);

      archive = join(work, 'backups', 'koda-db-20260101-000000-1.sql.gz');
      takeBackup(work, project, archive);
      writeNewerRows(work, project);

      // AC-1, AC-8: the documented procedure over a snapshot that is behind the live database. It ends on the
      // restored database; the reversal is a separate script and is run as one, below.
      successRun = runProcedure(work, project, 'success', procedureInputs(work, project, archive, RESTORED_DB));
      reversalRun = runReversal(work, project, 'reversal', procedureInputs(work, project, archive, RESTORED_DB));

      // AC-12: the same procedure from a shell that exports its own POSTGRES_DB. Compose gives the process
      // environment precedence over --env-file, so without the procedure's guard this cutover would leave the
      // synthetic client reading the original database while the environment file names the restored one.
      conflictRun = runProcedure(
        work,
        project,
        'inherited-postgres-db',
        procedureInputs(work, project, archive, CONFLICT_DB),
        { POSTGRES_DB: ORIGINAL_DB },
      );
      // Back to the original database through the documented reversal, so the cases below start where the
      // fixture started: this deployment serving ORIGINAL_DB.
      conflictReversalRun = runReversal(
        work,
        project,
        'inherited-postgres-db',
        procedureInputs(work, project, archive, CONFLICT_DB),
      );

      // AC-2, AC-3: a target that already exists, holding a row of its own.
      psqlIn(work, project, 'postgres', `create database ${REFUSED_DB};`);
      psqlIn(
        work,
        project,
        REFUSED_DB,
        `create table ${SENTINEL_TABLE} (id integer primary key, note text not null);
         insert into ${SENTINEL_TABLE} (id, note) values (1, 'do-not-touch');`,
      );
      refusedRun = runProcedure(work, project, 'refused', procedureInputs(work, project, archive, REFUSED_DB));

      // AC-4, AC-5: a valid archive whose SQL fails halfway through, with a sentinel insert behind the error.
      const badSql = join(work, 'backups', 'koda-db-bad-sql.sql.gz');
      writeFileSync(
        badSql,
        gzipSync(
          [
            'create table probe_before_error (id integer primary key, note text not null);',
            'insert into table_that_does_not_exist (id) values (1);',
            `insert into probe_before_error (id, note) values (1, '${BAD_SQL_SENTINEL}');`,
            '',
          ].join('\n'),
        ),
      );
      badSqlRun = runProcedure(work, project, 'bad-sql', procedureInputs(work, project, badSql, BAD_SQL_DB));

      // AC-6, AC-7: an archive that is not gzip at all, and one that stops in the middle.
      const invalidGzip = join(work, 'backups', 'koda-db-not-gzip.sql.gz');
      writeFileSync(invalidGzip, randomBytes(4096));
      invalidGzipRun = runProcedure(work, project, 'invalid-gzip', procedureInputs(work, project, invalidGzip, INVALID_GZIP_DB));

      const truncatedGzip = join(work, 'backups', 'koda-db-truncated.sql.gz');
      const complete = readFileSync(archive);
      writeFileSync(truncatedGzip, complete.subarray(0, Math.floor(complete.length / 2)));
      truncatedGzipRun = runProcedure(
        work,
        project,
        'truncated-gzip',
        procedureInputs(work, project, truncatedGzip, TRUNCATED_GZIP_DB),
      );

      // AC-9, AC-10, AC-11: the same procedure with a baseline that does not describe this backup.
      wrongBaselineRun = runProcedure(
        work,
        project,
        'wrong-baseline',
        procedureInputs(work, project, archive, WRONG_BASELINE_DB, { KODA_RESTORE_BASELINE_ROWS: '2' }),
      );
    } catch (error) {
      teardown(work, project);
      throw error;
    }
  });

  afterAll(() => {
    if (work === undefined || project === undefined) return;
    teardown(work, project);
  });

  it('AC-1: restores the snapshot into a distinct new database and leaves the newer rows in the original', () => {
    expect(successRun.stepIds).toEqual(EXPECTED_STEP_IDS);
    expect(successRun.status).toBe(0);
    expect(successRun.output).toContain('✅');

    // The restored database holds exactly the snapshot: nothing the original database gained afterwards.
    expect(psqlIn(work, project, RESTORED_DB, `select (id::text || ',' || note) from ${BASELINE_TABLE} order by id`)).toBe(
      '1,before',
    );
    // ... and the newer rows are still where the deployment left them.
    expect(
      psqlIn(work, project, ORIGINAL_DB, `select (id::text || ',' || note) from ${BASELINE_TABLE} order by id`),
    ).toBe('1,after\n2,new');
  });

  it('AC-2: refuses a target that already exists, before replaying into it', () => {
    expect(refusedRun.stepIds).toEqual(EXPECTED_STEP_IDS);
    expect(refusedRun.status).not.toBe(0);
    expect(refusedRun.output).toContain(REFUSED_DB);

    // The pre-existing row is untouched, and nothing the snapshot contains reached that database.
    expect(psqlIn(work, project, REFUSED_DB, `select (id::text || ',' || note) from ${SENTINEL_TABLE} order by id`)).toBe(
      REFUSED_SENTINEL,
    );
    expect(
      psqlIn(
        work,
        project,
        REFUSED_DB,
        `select count(*) from information_schema.tables where table_name = '${BASELINE_TABLE}'`,
      ),
    ).toBe('0');
  });

  it('AC-3: leaves the original database unchanged when the target is refused', () => {
    expect(refusedRun.status).not.toBe(0);
    expect(refusedRun.originalRowsAfter).toBe('1,after\n2,new');
    expect(refusedRun.originalRowsAfter).toBe(refusedRun.originalRowsBefore);
  });

  it('AC-4: stops at the SQL error instead of running the insert that follows it', () => {
    // `probe_before_error` exists because the statement before the error ran, so the replay was genuinely under
    // way when it failed; the row behind the error is missing, so psql stopped there.
    expect(psqlIn(work, project, BAD_SQL_DB, 'select count(*) from probe_before_error')).toBe('0');
    expect(badSqlRun.status).not.toBe(0);
  });

  it('AC-5: a failed replay never changes the persisted database setting', () => {
    expect(badSqlRun.status).not.toBe(0);
    expect(badSqlRun.persistedDbBefore).toBe(ORIGINAL_DB);
    expect(badSqlRun.persistedDbAfter).toBe(ORIGINAL_DB);
    expect(persistedDb(work)).toBe(ORIGINAL_DB);
    // A cutover would have recreated the synthetic client on the failed staging database; nothing did.
    expect(badSqlRun.writerStartsAdded).toBe(0);
    expect(badSqlRun.writerLinesAdded).toEqual([]);
  });

  it('AC-6: exits nonzero for an archive that is not gzip and for one that is truncated', () => {
    expect(invalidGzipRun.status).not.toBe(0);
    expect(truncatedGzipRun.status).not.toBe(0);
    // Neither archive was worth a staging database.
    expect(
      psqlIn(work, project, 'postgres', `select count(*) from pg_database where datname = '${INVALID_GZIP_DB}'`),
    ).toBe('0');
    expect(
      psqlIn(work, project, 'postgres', `select count(*) from pg_database where datname = '${TRUNCATED_GZIP_DB}'`),
    ).toBe('0');
  });

  it('AC-7: leaves the original database queryable with its pre-restore contents after an archive failure', () => {
    for (const run of [invalidGzipRun, truncatedGzipRun]) {
      expect(run.status).not.toBe(0);
      expect(run.originalRowsBefore).toBe('1,after\n2,new');
      expect(run.originalRowsAfter).toBe('1,after\n2,new');
    }
    expect(
      psqlIn(work, project, ORIGINAL_DB, `select (id::text || ',' || note) from ${BASELINE_TABLE} order by id`),
    ).toBe('1,after\n2,new');
  });

  it('AC-8: a successful restore ends on the restored database, and only the separate reversal leaves it', () => {
    expect(successRun.status).toBe(0);
    // The procedure's script is steps 1-5: the reversal is not part of it, so nothing undoes the cutover.
    expect(successRun.stepIds).toEqual(EXPECTED_STEP_IDS);
    expect(successRun.persistedDbBefore).toBe(ORIGINAL_DB);
    expect(successRun.persistedDbAfter).toBe(RESTORED_DB);
    // Exactly one start: the containers the cutover recreated, reading the backup's own row.
    expect(successRun.writerLinesAdded).toEqual([`start db=${RESTORED_DB} rows=before`]);
    expect(successRun.writerStartsAdded).toBe(1);
  });

  it('AC-8: the separately invoked reversal returns the deployment to the retained original database', () => {
    expect(reversalRun.status).toBe(0);
    expect(reversalRun.persistedDbBefore).toBe(RESTORED_DB);
    expect(reversalRun.persistedDbAfter).toBe(ORIGINAL_DB);
    // The recreated client reads the newer rows: the original database kept everything the restore did not
    // touch, which is what makes it a fallback.
    expect(reversalRun.writerLinesAdded).toEqual([`start db=${ORIGINAL_DB} rows=after,new`]);
    expect(reversalRun.writerStartsAdded).toBe(1);
  });

  it('AC-12: a POSTGRES_DB exported by the operator shell does not decide the database the deployment selects', () => {
    // The procedure ran with POSTGRES_DB=ORIGINAL_DB exported and the environment file naming CONFLICT_DB, which
    // is the case Compose resolves in favour of the shell unless the procedure removes it.
    expect(conflictRun.stepIds).toEqual(EXPECTED_STEP_IDS);
    expect(conflictRun.status).toBe(0);
    expect(conflictRun.persistedDbAfter).toBe(CONFLICT_DB);
    // The recreated client read the restored row: Compose resolved the environment file's database, not the
    // exported one, which would have read 'after,new' from the retained original database.
    expect(conflictRun.writerLinesAdded).toEqual([`start db=${CONFLICT_DB} rows=before`]);

    // The fixture is on the original database again for the cases below, through the documented reversal.
    expect(conflictReversalRun.status).toBe(0);
    expect(conflictReversalRun.persistedDbAfter).toBe(ORIGINAL_DB);
  });

  it('AC-9: an incorrect expected row baseline exits nonzero and keeps the original database selected', () => {
    expect(wrongBaselineRun.stepIds).toEqual(EXPECTED_STEP_IDS);
    expect(wrongBaselineRun.status).not.toBe(0);
    // The failure names the table and the count the procedure expected, so the operator knows which gate
    // refused the restore.
    expect(wrongBaselineRun.output).toContain(BASELINE_TABLE);
    expect(wrongBaselineRun.output).toMatch(/expected 2/);
    expect(wrongBaselineRun.persistedDbBefore).toBe(ORIGINAL_DB);
    expect(wrongBaselineRun.persistedDbAfter).toBe(ORIGINAL_DB);
    expect(persistedDb(work)).toBe(ORIGINAL_DB);
  });

  it('AC-10: an incorrect expected row baseline starts no application writer', () => {
    expect(wrongBaselineRun.status).not.toBe(0);
    expect(wrongBaselineRun.writerStartsAdded).toBe(0);
    expect(wrongBaselineRun.writerLinesAdded).toEqual([]);
  });

  it('AC-11: no failed step selects the failed staging database or starts a writer', () => {
    const failures: readonly ProcedureRun[] = [
      refusedRun,
      badSqlRun,
      invalidGzipRun,
      truncatedGzipRun,
      wrongBaselineRun,
    ];
    for (const run of failures) {
      expect(run.status, `${run.label} must fail`).not.toBe(0);
      expect(run.writerStartsAdded, `${run.label} must not start a writer`).toBe(0);
      expect(run.persistedDbAfter, `${run.label} must keep the original database selected`).toBe(ORIGINAL_DB);
    }
    expect(persistedDb(work)).toBe(ORIGINAL_DB);
    // The staged database a failed replay left behind is available for inspection, but nothing reads it.
    expect(psqlIn(work, project, 'postgres', `select count(*) from pg_database where datname = '${BAD_SQL_DB}'`)).toBe(
      '1',
    );
  });
});
