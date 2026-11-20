import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDeployScriptRuns, runDeployScript } from './helpers/deploy-script-harness';

afterEach(() => cleanupDeployScriptRuns());

describe('deploy.sh', () => {
  const lines = (extra: string) => `POSTGRES_PASSWORD=pw\n${extra}`;

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
});
