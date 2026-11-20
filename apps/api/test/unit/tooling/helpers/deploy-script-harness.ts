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
  readdirSync,
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
 * A run copies `deployments/example/` into a fresh temp dir (the run's `dir`), puts a recording `docker`
 * stub, a `curl` stub, a pin-able `date` shim (`KODA_DEPLOY_HARNESS_DATE`, set through `opts.env`) and a
 * `bash` shim first on `PATH`, and runs `/bin/bash <dir>/<script> ...args` with an environment built from
 * `PATH` and `HOME` only, plus `opts.env`: an operator's exported
 * `POSTGRES_PASSWORD`, `KODA_VERSION`, `DATABASE_URL` or `COMPOSE_PROJECT_NAME` never reaches the
 * script. The `bash` shim execs `/bin/bash`, so a script that `deploy.sh` runs through its
 * `#!/usr/bin/env bash` line also runs under the host bash (3.2 on macOS), like the script under test.
 */

export interface DockerCall {
  argv: string[];
  kodaVersion: string;
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
const STUB_DIR = join(__dirname, 'deploy-script-stubs');
const CURL_STUB = '#!/bin/bash\nexit 0\n';
const BASH_SHIM = '#!/bin/sh\nexec /bin/bash "$@"\n';
const FIELD_SEPARATOR = '\u0000';
const RUN_TIMEOUT_MS = 120_000;

const createdDirs: string[] = [];

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** Copies the example deployment, keeping each script executable (`deploy.sh` checks `-x backup-db.sh`). */
function copyExample(dir: string): void {
  for (const entry of readdirSync(EXAMPLE_DIR)) {
    // A developer's local dumps must not leak into the copy: the tests assert on `backups/`.
    if (entry === 'backups') continue;
    cpSync(join(EXAMPLE_DIR, entry), join(dir, entry), { recursive: true });
    if (entry.endsWith('.sh')) chmodSync(join(dir, entry), 0o755);
  }
}

/** Reads the NUL-separated records the `docker` stub appends: count, KODA_VERSION, then the arguments. */
function readDockerCalls(recordFile: string): DockerCall[] {
  const raw = readFileSync(recordFile);
  if (raw.length === 0) return [];

  const fields = raw.toString('utf8').split(FIELD_SEPARATOR);
  const calls: DockerCall[] = [];
  let index = 0;
  while (index < fields.length) {
    const count = Number(fields[index]);
    if (fields[index] === '' || !Number.isInteger(count)) break;
    calls.push({
      argv: fields.slice(index + 2, index + 2 + count),
      kodaVersion: fields[index + 1] ?? '',
    });
    index += 2 + count;
  }
  return calls;
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
  opts: { envFile?: string; envFileMode?: number; env?: Record<string, string>; docker?: StubBehaviour } = {},
): ScriptRun {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'koda-deploy-script-')));
  createdDirs.push(dir);
  copyExample(dir);

  const harnessDir = join(dir, '.harness');
  const binDir = join(harnessDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const recordFile = join(harnessDir, 'docker-calls');
  const outputFile = join(harnessDir, 'output');
  const pgDumpFile = join(harnessDir, 'pg-dump');
  writeFileSync(recordFile, '');
  writeFileSync(outputFile, '');
  writeFileSync(pgDumpFile, opts.docker?.pgDump ?? DEFAULT_PG_DUMP);

  writeExecutable(join(binDir, 'docker'), readFileSync(join(STUB_DIR, 'docker'), 'utf8'));
  writeExecutable(join(binDir, 'date'), readFileSync(join(STUB_DIR, 'date'), 'utf8'));
  writeExecutable(join(binDir, 'curl'), CURL_STUB);
  writeExecutable(join(binDir, 'bash'), BASH_SHIM);

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
    KODA_DEPLOY_HARNESS_PG_DUMP: pgDumpFile,
    KODA_DEPLOY_HARNESS_PG_DUMP_EXIT: String(opts.docker?.pgDumpExit ?? 0),
    KODA_DEPLOY_HARNESS_FAIL_ON: (opts.docker?.failOn ?? []).join('\n'),
  };

  // Both streams go to one file so the output keeps the order the script wrote it in.
  const outputFd = openSync(outputFile, 'w');
  let status: number;
  try {
    const result = spawnSync('/bin/bash', [join(dir, script), ...placeFixtureArguments(dir, args)], {
      cwd: dir,
      env,
      stdio: ['ignore', outputFd, outputFd],
      timeout: RUN_TIMEOUT_MS,
    });
    status = result.status ?? 1;
  } finally {
    closeSync(outputFd);
  }

  return {
    status,
    output: readFileSync(outputFile, 'utf8'),
    dockerCalls: readDockerCalls(recordFile),
    dir,
  };
}

/** Removes every per-test copy; call it from the suite's `afterEach`. */
export function cleanupDeployScriptRuns(): void {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
