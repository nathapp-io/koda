import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupDeployScriptRuns, runDeployScript } from './helpers/deploy-script-harness';

vi.setConfig({ testTimeout: 30_000 });

const decoyRoots: string[] = [];

/** A second environment file an operator could point `COMPOSE_ENV_FILES` at. */
function decoyEnvFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-deploy-decoy-env-'));
  decoyRoots.push(root);
  const file = join(root, 'other.env');
  writeFileSync(file, contents);
  return file;
}

/**
 * The arguments that decide which Compose project a call acts on: the environment file and the Compose
 * file, up to the subcommand.
 */
function composeSelection(argv: string[]): string[] {
  const selection = ['compose'];
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== '--env-file' && argv[index] !== '-f') break;
    selection.push(argv[index], argv[index + 1] ?? '');
    index += 1;
  }
  return selection;
}

afterEach(() => {
  cleanupDeployScriptRuns();
  for (const root of decoyRoots.splice(0, decoyRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('deploy.sh', () => {
  const lines = (extra: string) => `POSTGRES_PASSWORD=pw\n${extra}`;

  it('AC-1a: accepts a bare valid POSTGRES_PASSWORD assignment', () => {
    const run = runDeployScript('deploy.sh', ['--no-backup'], { envFile: 'POSTGRES_PASSWORD=valid_pw-1\n' });

    expect(run.status, run.output).toBe(0);
    expect(run.dockerCalls.some(({ argv }) => argv.includes('config'))).toBe(true);
  });

  it('AC-1b: accepts an export-prefixed valid POSTGRES_PASSWORD assignment', () => {
    const run = runDeployScript('deploy.sh', ['--no-backup'], { envFile: 'export POSTGRES_PASSWORD=valid_pw-1\n' });

    expect(run.status, run.output).toBe(0);
    expect(run.dockerCalls.some(({ argv }) => argv.includes('config'))).toBe(true);
  });

  it('AC-1c: gives an explicitly set shell password precedence over the .env assignment', () => {
    const run = runDeployScript('deploy.sh', ['--no-backup'], {
      envFile: 'export POSTGRES_PASSWORD=valid_pw-1\n',
      env: { POSTGRES_PASSWORD: 'invalid/password' },
    });

    expect(run.status).not.toBe(0);
    expect(run.dockerCalls).toEqual([]);
  });

  it('AC-2a: refuses an absent password before invoking Docker', () => {
    const run = runDeployScript('deploy.sh', ['--no-backup']);

    expect(run.status).not.toBe(0);
    expect(run.dockerCalls).toEqual([]);
  });

  it('AC-2b: refuses an invalid supplied password before Docker without printing it', () => {
    const secret = 'invalid/password-secret';
    const run = runDeployScript('deploy.sh', ['--no-backup'], { envFile: `POSTGRES_PASSWORD=${secret}\n` });

    expect(run.status).not.toBe(0);
    expect(run.dockerCalls).toEqual([]);
    expect(run.output).not.toContain(secret);
  });

  it('AC-2c: never prints a supplied password when preflight succeeds', () => {
    const secret = 'private_pw-1';
    const run = runDeployScript('deploy.sh', ['--no-backup'], { envFile: `export POSTGRES_PASSWORD=${secret}\n` });

    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain(secret);
  });

  it('AC-1: exits 1 when .env assigns DATABASE_URL', () => {
    expect(runDeployScript('deploy.sh', [], { envFile: lines('DATABASE_URL=postgresql://db.example/koda') }).status).toBe(1);
  });

  it('AC-2: prints the unsupported DATABASE_URL explanation', () => {
    const run = runDeployScript('deploy.sh', [], { envFile: lines('DATABASE_URL=postgresql://db.example/koda') });
    expect(run.output).toContain('❌ DATABASE_URL is not supported by this example deployment: it always uses the bundled postgres service');
  });

  it('AC-3: makes no docker call for a DATABASE_URL assignment', () => {
    expect(runDeployScript('deploy.sh', [], { envFile: lines('DATABASE_URL=postgresql://db.example/koda') }).dockerCalls).toEqual([]);
  });

  it('AC-4: rejects a whitespace-padded DATABASE_URL assignment', () => {
    expect(runDeployScript('deploy.sh', [], { envFile: lines('  DATABASE_URL = postgresql://db.example/koda') }).dockerCalls).toEqual([]);
  });

  it('AC-5: rejects an exported DATABASE_URL assignment in .env', () => {
    expect(runDeployScript('deploy.sh', [], { envFile: lines('export DATABASE_URL="postgresql://db.example/koda"') }).dockerCalls).toEqual([]);
  });

  it('AC-6: rejects an empty DATABASE_URL assignment', () => {
    expect(runDeployScript('deploy.sh', [], { envFile: lines('DATABASE_URL=') }).dockerCalls).toEqual([]);
  });

  it('AC-7: ignores a commented DATABASE_URL and runs migrations', () => {
    const run = runDeployScript('deploy.sh', [], { envFile: lines('# DATABASE_URL=postgresql://db.example/koda') });
    expect(run.dockerCalls.some(({ argv }) => argv.includes('migrate') && argv.includes('deploy'))).toBe(true);
  });

  it('AC-8: permits DATABASE_URL exported in the operator environment', () => {
    expect(runDeployScript('deploy.sh', [], {
      envFile: 'POSTGRES_PASSWORD=pw',
      env: { DATABASE_URL: 'postgresql://db.example/koda' },
    }).status).toBe(0);
  });

  it('AC-9: exits non-zero when the pre-deploy pg_dump fails', () => {
    expect(runDeployScript('deploy.sh', [], { envFile: 'POSTGRES_PASSWORD=pw', docker: { pgDumpExit: 1 } }).status).not.toBe(0);
  });

  it('AC-10: does not migrate after the pre-deploy pg_dump fails', () => {
    const run = runDeployScript('deploy.sh', [], { envFile: 'POSTGRES_PASSWORD=pw', docker: { pgDumpExit: 1 } });
    expect(run.dockerCalls.some(({ argv }) => argv.includes('migrate'))).toBe(false);
  });

  it('B1: backs up and migrates the same Compose project when COMPOSE_ENV_FILES points elsewhere', () => {
    const decoy = decoyEnvFile('COMPOSE_PROJECT_NAME=other\n');
    const run = runDeployScript('deploy.sh', [], {
      envFile: 'POSTGRES_PASSWORD=pw\nCOMPOSE_PROJECT_NAME=target\n',
      env: { COMPOSE_ENV_FILES: decoy },
    });

    expect(run.status).toBe(0);
    const backupStart = run.dockerCalls.find(({ argv }) => argv.includes('--wait') && argv.includes('postgres'));
    const migration = run.dockerCalls.find(({ argv }) => argv.includes('migrate') && argv.includes('deploy'));
    expect(backupStart).toBeDefined();
    expect(migration).toBeDefined();

    // `deploy.sh` pins `.env` for its own calls and runs `backup-db.sh` as a separate process: both must
    // resolve the same project, or a successful backup of one stack lets deploy migrate another (review B1).
    const expected = ['compose', '--env-file', `${run.dir}/.env`, '-f', `${run.dir}/docker-compose.yml`];
    expect(composeSelection(backupStart?.argv ?? [])).toEqual(expected);
    expect(composeSelection(migration?.argv ?? [])).toEqual(expected);
    const distinctSelections = new Set(run.dockerCalls.map(({ argv }) => composeSelection(argv).join(' ')));
    expect(distinctSelections).toEqual(new Set([expected.join(' ')]));
  });
  it('B17: does not run a Compose-valid `.env` line as shell in its health checks', () => {
    // Compose accepts `KEY: value` and quoted multiline values; bash does not. `deploy.sh` used to source `.env`
    // to read the health-check ports, which ran such a line as a command after the services were replaced
    // (review rollback.sh:289). It asks Compose for the published ports instead.
    const run = runDeployScript('deploy.sh', [], {
      envFile: lines('OLLAMA_BASE_URL: http://ollama:11434\nOLLAMA_MODEL="llama3\nmultiline"\n'),
    });

    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('command not found');
    // The ports come from Compose's own view of the running stack, for both services.
    const ports = run.dockerCalls
      .filter(({ argv }) => argv.includes('port'))
      .map(({ argv }) => argv.slice(argv.indexOf('port') + 1).join(' '));
    expect(ports).toEqual(['api 3100', 'web 3101']);
  });
  it('B17: does not treat an assignment-shaped line inside a quoted value as DATABASE_URL', () => {
    // Compose accepts a quoted value spanning lines; a configuration example inside it is text, not an override
    // (review deploy.sh:94).
    const run = runDeployScript('deploy.sh', [], {
      envFile: 'POSTGRES_PASSWORD=pw\nNOTE="example:\nDATABASE_URL=literal-example\nend"\n',
    });

    expect(run.status, run.output).toBe(0);
    expect(run.dockerCalls.some(({ argv }) => argv.includes('migrate') && argv.includes('deploy'))).toBe(true);
  });
});
