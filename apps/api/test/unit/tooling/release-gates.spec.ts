import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobBlock, readWorkflow, stepBody } from './helpers/workflow-steps';

const release = readWorkflow('release.yml');
const ci = readWorkflow('ci.yml');

const MANIFESTS = ['package.json', 'apps/api/package.json', 'apps/cli/package.json', 'apps/web/package.json'];

interface StepRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runStep(body: string, dir: string, env: Record<string, string>): StepRun {
  const scriptFile = join(dir, 'step.sh');
  writeFileSync(scriptFile, body);
  const result = spawnSync('/bin/bash', ['-e', scriptFile], {
    cwd: dir,
    env: { ...process.env, ...env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function stub(dir: string, name: string, script: string): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'koda-release-gates-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release workflow: every published manifest matches the tag', () => {
  function validate(versions: Record<string, string>, tag: string): StepRun {
    return withTempDir((dir) => {
      for (const manifest of MANIFESTS) {
        mkdirSync(join(dir, manifest, '..'), { recursive: true });
        writeFileSync(join(dir, manifest), JSON.stringify({ name: manifest, version: versions[manifest] ?? '0.5.0' }));
      }
      return runStep(stepBody(release, '- name: Validate version'), dir, { TAG: tag });
    });
  }

  it('passes when root, api, cli and web all carry the tag version', () => {
    const run = validate({}, 'v0.5.0');
    expect(run.status).toBe(0);
  });

  it('fails and names the manifest that is behind the tag', () => {
    const run = validate({ 'apps/web/package.json': '0.4.2' }, 'v0.5.0');
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('apps/web/package.json');
  });

  it('does not require the separately versioned runner to match', () => {
    expect(stepBody(release, '- name: Validate version')).not.toContain('apps/runner');
  });
});

describe('release workflow: CI must have passed on the release commit', () => {
  const SHA = '1234567890abcdef1234567890abcdef12345678';

  /**
   * Each gh call prints the next entry of `responses` (a `|`-separated list of "status conclusion" lines; `-` is no
   * runs at all). Past the last entry, the last one repeats.
   */
  function gate(responses: string[], opts: { ghExit?: number; waitSeconds?: string } = {}): StepRun & { calls: number } {
    return withTempDir((dir) => {
      writeFileSync(join(dir, 'responses'), responses.join('\n') + '\n');
      writeFileSync(join(dir, 'count'), '0');
      stub(dir, 'git', `if [[ "$1" == "rev-parse" ]]; then echo ${SHA}; exit 0; fi\nexit 2`);
      stub(
        dir,
        'gh',
        [
          `count=$(cat "${dir}/count"); count=$((count + 1)); echo "$count" > "${dir}/count"`,
          `echo "$*" >> "${dir}/args"`,
          `[ "${opts.ghExit ?? 0}" = 0 ] || exit ${opts.ghExit ?? 0}`,
          `line=$(sed -n "\${count}p" "${dir}/responses")`,
          `[ -z "$line" ] && line=$(tail -n 1 "${dir}/responses")`,
          `[ "$line" = "-" ] && exit 0`,
          `printf '%s' "$line" | tr '|' '\\n'`,
        ].join('\n'),
      );
      const run = runStep(stepBody(release, 'id: ci-gate'), dir, {
        REPOSITORY: 'nathapp-io/koda',
        CI_WAIT_SECONDS: opts.waitSeconds ?? '30',
        CI_POLL_SECONDS: '0',
      });
      const args = existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8') : '';
      expect(args).toContain(`head_sha=${SHA}`);
      return { ...run, calls: Number(readFileSync(join(dir, 'count'), 'utf8').trim()) };
    });
  }

  it('passes when a CI run for the commit succeeded', () => {
    const run = gate(['completed success']);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(1);
  });

  it('passes when one run succeeded even though an earlier run failed', () => {
    expect(gate(['completed failure|completed success']).status).toBe(0);
  });

  it('waits for a run that is still in progress, then passes', () => {
    const run = gate(['in_progress none', 'queued none', 'completed success']);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(3);
  });

  it('waits for the CI run to appear after the tag push', () => {
    const run = gate(['-', 'in_progress none', 'completed success']);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(3);
  });

  it('fails at once when every run for the commit finished without success', () => {
    const run = gate(['completed failure|completed cancelled']);
    expect(run.status).not.toBe(0);
    expect(run.calls).toBe(1);
    expect(run.stdout).toContain('gh workflow run ci.yml');
  });

  it('fails when no CI run appears before the deadline', () => {
    const run = gate(['-'], { waitSeconds: '0' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(SHA);
  });

  it('fails closed when the GitHub API call fails', () => {
    expect(gate(['completed success'], { ghExit: 1 }).status).not.toBe(0);
  });

  it('runs in the info job, before any publishing job, with read access to Actions', () => {
    const info = jobBlock(release, 'info');
    expect(info).toContain('id: ci-gate');
    expect(info).toMatch(/permissions:\n\s+contents: read\n\s+actions: read/);
    expect(info).toContain('GH_TOKEN: ${{ github.token }}');
    expect(jobBlock(release, 'cli')).toContain('needs: info');
  });

  it('lets a maintainer start CI by hand for a commit the push filter skipped', () => {
    const on = ci.slice(0, ci.indexOf('\npermissions:'));
    expect(on).toMatch(/\n  workflow_dispatch:\n/);
  });
});

describe('release workflow: Telegram notification', () => {
  const notify = jobBlock(release, 'notify');

  it('reads the chat id from the release environment secrets it is stored in', () => {
    expect(notify).toContain('environment: release');
    expect(notify).toContain('TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}');
    expect(release).not.toContain('vars.TELEGRAM_CHAT_ID');
  });

  it('skips quietly when Telegram is not configured', () => {
    withTempDir((dir) => {
      stub(dir, 'curl', `touch "${dir}/curl-called"`);
      const run = runStep(stepBody(release, '- name: Send Telegram notification'), dir, {
        VERSION: 'v0.5.0',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      });
      expect(run.status).toBe(0);
      expect(existsSync(join(dir, 'curl-called'))).toBe(false);
    });
  });

  it('sends when both the token and the chat id are set', () => {
    withTempDir((dir) => {
      stub(dir, 'curl', `touch "${dir}/curl-called"`);
      const run = runStep(stepBody(release, '- name: Send Telegram notification'), dir, {
        VERSION: 'v0.5.0',
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '42',
      });
      expect(run.status).toBe(0);
      expect(existsSync(join(dir, 'curl-called'))).toBe(true);
    });
  });
});
