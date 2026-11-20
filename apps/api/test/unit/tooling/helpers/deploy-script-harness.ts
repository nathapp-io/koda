import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Runs the example deployment scripts (`deployments/example/*.sh`) against recording stubs, so the
 * deploy behaviour can be asserted without Docker.
 *
 * A run copies the deployment files the scripts read (`docker-compose.yml` and the three scripts, never the
 * example's `README.md`, `backups/` or a developer's local `.env`) into a fresh temp dir (the run's `dir`),
 * puts a recording `docker` stub, a `curl` stub, a pass-through `gzip` shim (corrupt output on demand,
 * `KODA_DEPLOY_HARNESS_GZIP_CORRUPT`, set through `opts.env`), a pin-able `date` shim
 * (`KODA_DEPLOY_HARNESS_DATE`, likewise) and a `bash` shim first on `PATH`, and runs
 * `/bin/bash <dir>/<script> ...args` with an environment built from
 * `PATH` and `HOME` only, plus `opts.env`: an operator's exported
 * `POSTGRES_PASSWORD`, `KODA_VERSION`, `DATABASE_URL` or `COMPOSE_PROJECT_NAME` never reaches the
 * script. The `bash` shim execs `/bin/bash`, so a script that `deploy.sh` runs through its
 * `#!/usr/bin/env bash` line also runs under the host bash (3.2 on macOS), like the script under test.
 *
 * `opts.umask` sets the umask of the script's own process (in a child shell, so the test process keeps its
 * umask), and `opts.backupsDirMode` / `opts.backupsIsFile` place an existing `backups/` directory with a
 * given mode, or a regular file where that directory belongs, before the script starts.
 *
 * The stub does not only record: a `compose run … -c <script> <args…>` call (how a restore pipeline reaches
 * the volume) really executes that command on the host with `/data` bound to a fake volume under the run
 * directory and `/backup` bound to the host directory the call mounts. `opts.seedVolume` populates that
 * volume before the script starts and `run.dataDir` exposes it afterwards, so a test can assert the files a
 * restore leaves behind instead of only the arguments it passed.
 */

export interface DockerCall {
  argv: string[];
  kodaVersion: string;
  /** The umask the script ran with when it made this call, e.g. `022`. */
  umask: string;
  /** The mode of the script's `backups/` directory at call time, or `undefined` before it existed. */
  backupsDirMode?: string;
}

export interface StubBehaviour {
  /** The stub exits 1 for a call whose joined argv contains one of these substrings. */
  failOn?: string[];
  /** Stdout for the call that runs `pg_dump` (default: {@link DEFAULT_PG_DUMP}). */
  pgDump?: string;
  /** Exit code for that call (default 0). */
  pgDumpExit?: number;
}

export interface ScriptRun {
  status: number;
  output: string;
  dockerCalls: DockerCall[];
  /** The temp copy of `deployments/example`, real path, as the script's own `SCRIPT_DIR`. */
  dir: string;
  /**
   * The fake `koda_data` volume. A `compose run … -c <script> <args…>` call (a restore pipeline) really
   * executes its command on the host with `/data` bound here and `/backup` bound to the directory the call
   * mounts, so a test can assert the files a restore leaves behind (review B12, B13).
   */
  dataDir: string;
  /** Runs the same script again against the same deployment and Docker stub state, with a fresh call log. */
  rerun: (args: string[]) => ScriptRun;
}

/** A complete `pg_dump` output: the last comment line is what `backup-db.sh` verifies. */
export const DEFAULT_PG_DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '-- PostgreSQL database dump complete',
  '',
].join('\n');

const EXAMPLE_DIR = resolve(__dirname, '../../../../../../deployments/example');
/**
 * The deployment files the scripts under test read. Listed one by one, so a developer's local `.env`,
 * `backups/` or any later file in the example directory cannot change what a test starts from (review B10).
 */
const EXAMPLE_FILES = ['docker-compose.yml', 'deploy.sh', 'backup-db.sh', 'rollback.sh'] as const;
const STUB_DIR = join(__dirname, 'deploy-script-stubs');
const CURL_STUB = '#!/bin/bash\nexit 0\n';
const BASH_SHIM = '#!/bin/sh\nexec /bin/bash "$@"\n';
/**
 * Pass-through `gzip`, except when `KODA_DEPLOY_HARNESS_GZIP_CORRUPT` is set: compressing then writes a
 * valid gzip followed by trailing garbage, which is the shape of a dump file that was corrupted after it
 * was written. The shell has no way to corrupt the script's own output otherwise, and the script's
 * verification has to reject the archive. Decompression and `-t` always run the real `gzip`, so the check
 * the script makes is the real one.
 */
const gzipShim = (realGzip: string): string => `#!/bin/bash
if [[ "\${KODA_DEPLOY_HARNESS_GZIP_CORRUPT-}" = 1 && $# -eq 0 ]]; then
  scratch="$(mktemp)"
  trap 'rm -f "$scratch"' EXIT
  "${realGzip}" > "$scratch" || exit 1
  printf 'trailing-garbage-not-a-gzip-member' >> "$scratch"
  cat "$scratch"
  exit $?
fi
exec "${realGzip}" "$@"
`;
const FIELD_SEPARATOR = '\u0000';
/** Fields the stub writes ahead of a call's arguments: argument count, KODA_VERSION, umask, dir mode. */
const RECORD_HEADER_FIELDS = 4;
const RUN_TIMEOUT_MS = 120_000;

const createdDirs: string[] = [];

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/**
 * The `gzip` the shim delegates to. Resolved once from the test process's own `PATH`, before the shim
 * directory is put in front of it, so the shim can never call itself.
 */
let realGzipPath: string | undefined;
function resolveRealGzip(): string {
  if (realGzipPath !== undefined) return realGzipPath;
  const found = spawnSync('/bin/sh', ['-c', 'command -v gzip'], { encoding: 'utf8' });
  const resolved = found.stdout.trim();
  if (found.status !== 0 || resolved === '') {
    throw new Error('the deploy script harness needs a real gzip on PATH');
  }
  realGzipPath = resolved;
  return resolved;
}

/** Copies the deployment files a script reads, keeping each script executable (`deploy.sh` checks `-x backup-db.sh`). */
function copyExample(dir: string): void {
  for (const entry of EXAMPLE_FILES) {
    cpSync(join(EXAMPLE_DIR, entry), join(dir, entry));
    if (entry.endsWith('.sh')) chmodSync(join(dir, entry), 0o755);
  }
}

/** Reads the NUL-separated records the `docker` stub appends: count, KODA_VERSION, umask, dir mode, arguments. */
function readDockerCalls(recordFile: string): DockerCall[] {
  const raw = readFileSync(recordFile);
  if (raw.length === 0) return [];

  const fields = raw.toString('utf8').split(FIELD_SEPARATOR);
  const calls: DockerCall[] = [];
  let index = 0;
  while (index < fields.length) {
    const count = Number(fields[index]);
    if (fields[index] === '' || !Number.isInteger(count)) break;
    const dirMode = fields[index + 3];
    calls.push({
      argv: fields.slice(index + RECORD_HEADER_FIELDS, index + RECORD_HEADER_FIELDS + count),
      kodaVersion: fields[index + 1] ?? '',
      umask: normalizeUmask(fields[index + 2] ?? ''),
      ...(dirMode === undefined || dirMode === '-' || dirMode === '' ? {} : { backupsDirMode: dirMode }),
    });
    index += RECORD_HEADER_FIELDS + count;
  }
  return calls;
}

/** Bash prints the mask as `0022`, another shell may print `22`; every test asserts the same three digits. */
function normalizeUmask(raw: string): string {
  return (raw.replace(/^0+/, '') || '0').padStart(3, '0');
}

/**
 * Moves a fixture a test passes as an absolute argument under `dir`, so every path the script resolves
 * with `cd ... && pwd` is the same real path the test asserted on. An argument that already points inside
 * `dir` is left alone, and a fixture path that does not exist is only re-pointed, not created (the
 * missing-backup case).
 */
function placeFixtureArguments(dir: string, args: string[]): string[] {
  return args.map((argument) => {
    if (!isAbsolute(argument)) return argument;
    const source = resolve(argument);
    const fromDir = relative(dir, source);
    if (fromDir === '' || (!fromDir.startsWith('..') && !isAbsolute(fromDir))) return argument;

    const target = join(dir, basename(source));
    if (existsSync(source)) {
      cpSync(source, target, { recursive: true });
      chmodSync(target, statSync(source).mode & 0o777);
    }
    return target;
  });
}

export function runDeployScript(
  script: 'backup-db.sh' | 'rollback.sh' | 'deploy.sh',
  args: string[],
  opts: {
    envFile?: string;
    envFileMode?: number;
    env?: Record<string, string>;
    docker?: StubBehaviour;
    /** Populates the fake `koda_data` volume before the script starts, i.e. the data a rollback replaces. */
    seedVolume?: (dataDir: string) => void;
    /**
     * The umask the script's own process starts with (`umask` is per-process, so an operator's 022 is
     * reproduced in the child shell and the test process keeps its own).
     */
    umask?: string;
    /** Creates the script's `backups/` directory with this mode before it starts, e.g. an earlier 0755 run. */
    backupsDirMode?: number;
    /** Puts a regular file where the script's `backups/` directory belongs. */
    backupsIsFile?: boolean;
  } = {},
): ScriptRun {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'koda-deploy-script-')));
  createdDirs.push(dir);
  copyExample(dir);

  const harnessDir = join(dir, '.harness');
  const binDir = join(harnessDir, 'bin');
  const dataDir = join(harnessDir, 'volume');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  opts.seedVolume?.(dataDir);

  const backupsDir = join(dir, 'backups');
  if (opts.backupsIsFile === true) {
    writeFileSync(backupsDir, 'not a directory\n');
  } else if (opts.backupsDirMode !== undefined) {
    mkdirSync(backupsDir);
    chmodSync(backupsDir, opts.backupsDirMode);
  }

  const recordFile = join(harnessDir, 'docker-calls');
  const outputFile = join(harnessDir, 'output');
  const pgDumpFile = join(harnessDir, 'pg-dump');
  writeFileSync(pgDumpFile, opts.docker?.pgDump ?? DEFAULT_PG_DUMP);

  writeExecutable(join(binDir, 'docker'), readFileSync(join(STUB_DIR, 'docker'), 'utf8'));
  writeExecutable(join(binDir, 'date'), readFileSync(join(STUB_DIR, 'date'), 'utf8'));
  writeExecutable(join(binDir, 'curl'), CURL_STUB);
  writeExecutable(join(binDir, 'bash'), BASH_SHIM);
  writeExecutable(join(binDir, 'gzip'), gzipShim(resolveRealGzip()));

  if (opts.envFile !== undefined) {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, opts.envFile);
    chmodSync(envFile, opts.envFileMode ?? 0o644);
  }

  const env: Record<string, string> = {
    ...opts.env,
    PATH: `${binDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: process.env.HOME ?? dir,
    KODA_DEPLOY_HARNESS_RECORD: recordFile,
    KODA_DEPLOY_HARNESS_DIR: dir,
    KODA_DEPLOY_HARNESS_VOLUME: dataDir,
    KODA_DEPLOY_HARNESS_PG_DUMP: pgDumpFile,
    KODA_DEPLOY_HARNESS_PG_DUMP_EXIT: String(opts.docker?.pgDumpExit ?? 0),
    KODA_DEPLOY_HARNESS_FAIL_ON: (opts.docker?.failOn ?? []).join('\n'),
  };
  const childUmask = opts.umask;
  if (childUmask !== undefined && !/^[0-7]{1,4}$/.test(childUmask)) {
    throw new Error(`invalid umask fixture: ${childUmask}`);
  }

  const run = (scriptArgs: string[]): ScriptRun => {
    writeFileSync(recordFile, '');
    // Both streams go to one file so the output keeps the order the script wrote it in.
    const outputFd = openSync(outputFile, 'w');
    let status: number;
    try {
      // `umask` belongs to the process: set it in a child shell and exec the script from there, so a
      // umask fixture never changes the umask of the test process that runs the suite.
      const prefix = childUmask === undefined ? '' : `umask ${childUmask}; `;
      const result = spawnSync(
        '/bin/sh',
        ['-c', `${prefix}exec /bin/bash "$@"`, 'sh', join(dir, script), ...placeFixtureArguments(dir, scriptArgs)],
        {
          cwd: dir,
          env,
          stdio: ['ignore', outputFd, outputFd],
          timeout: RUN_TIMEOUT_MS,
        },
      );
      status = result.status ?? 1;
    } finally {
      closeSync(outputFd);
    }

    return {
      status,
      output: readFileSync(outputFile, 'utf8'),
      dockerCalls: readDockerCalls(recordFile),
      dir,
      dataDir,
      rerun: run,
    };
  };
  return run(args);
}

/** Removes every per-test copy; call it from the suite's `afterEach`. */
export function cleanupDeployScriptRuns(): void {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
