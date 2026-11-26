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

  interface CiRun {
    status: string;
    conclusion: string | null;
    event: string;
  }

  const push = (status: string, conclusion: string | null = null): CiRun => ({ status, conclusion, event: 'push' });

  /**
   * Stub gh: a `compare` call answers `{"status": <compare>}`; each runs call answers the next entry of `responses`
   * (a list of runs, or 'ERR' for an API failure), the last one repeating. Like the real gh, `--jq` is applied, by
   * jq, so the workflow's filter is what decides which runs count.
   */
  function gate(
    responses: Array<CiRun[] | 'ERR'>,
    opts: { compare?: string; compareExit?: number; waitSeconds?: string } = {},
  ): StepRun & { calls: number } {
    return withTempDir((dir) => {
      const lines = responses.map((r) => (r === 'ERR' ? 'ERR' : JSON.stringify({ workflow_runs: r })));
      writeFileSync(join(dir, 'responses'), lines.join('\n') + '\n');
      writeFileSync(join(dir, 'count'), '0');
      stub(dir, 'git', `if [[ "$1" == "rev-parse" ]]; then echo ${SHA}; exit 0; fi\nexit 2`);
      stub(
        dir,
        'gh',
        [
          'jq_expr=""; prev=""',
          'for arg in "$@"; do [ "$prev" = "--jq" ] && jq_expr="$arg"; prev="$arg"; done',
          `echo "$*" >> "${dir}/args"`,
          'case "$*" in',
          `  */compare/*) [ "${opts.compareExit ?? 0}" = 0 ] || exit ${opts.compareExit ?? 0}`,
          `    printf '%s' '{"status":"${opts.compare ?? 'identical'}"}' | jq -r "$jq_expr"; exit 0 ;;`,
          'esac',
          `count=$(cat "${dir}/count"); count=$((count + 1)); echo "$count" > "${dir}/count"`,
          `line=$(sed -n "\${count}p" "${dir}/responses")`,
          `[ -z "$line" ] && line=$(tail -n 1 "${dir}/responses")`,
          '[ "$line" = "ERR" ] && exit 1',
          'printf \'%s\' "$line" | jq -r "$jq_expr"',
        ].join('\n'),
      );
      const run = runStep(stepBody(release, 'id: ci-gate'), dir, {
        REPOSITORY: 'nathapp-io/koda',
        TAG: 'v0.5.0',
        CI_WAIT_SECONDS: opts.waitSeconds ?? '30',
        CI_POLL_SECONDS: '0',
      });
      const args = existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8') : '';
      if (run.status === 0) expect(args).toContain(`head_sha=${SHA}`);
      return { ...run, calls: Number(readFileSync(join(dir, 'count'), 'utf8').trim()) };
    });
  }

  it('passes when a push run for the commit succeeded', () => {
    const run = gate([[push('completed', 'success')]]);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(1);
  });

  it('passes on a successful manual run (workflow_dispatch) of CI', () => {
    expect(gate([[{ status: 'completed', conclusion: 'success', event: 'workflow_dispatch' }]]).status).toBe(0);
  });

  it('passes when one run succeeded even though an earlier run failed', () => {
    expect(gate([[push('completed', 'failure'), push('completed', 'success')]]).status).toBe(0);
  });

  it('does not count a pull_request run: it tested the merge ref, not this commit', () => {
    const run = gate([[{ status: 'completed', conclusion: 'success', event: 'pull_request' }]], { waitSeconds: '0' });
    expect(run.status).not.toBe(0);
  });

  it('waits for a run that is still in progress, then passes', () => {
    const run = gate([[push('in_progress')], [push('queued')], [push('completed', 'success')]]);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(3);
  });

  it('waits for the CI run to appear after the tag push', () => {
    const run = gate([[], [push('in_progress')], [push('completed', 'success')]]);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(3);
  });

  it('keeps waiting after a run main CI cancelled, so a re-run can land', () => {
    const run = gate([[push('completed', 'cancelled')], [push('completed', 'cancelled'), push('completed', 'success')]]);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(2);
  });

  it('fails at once when a run for the commit failed and none is pending', () => {
    const run = gate([[push('completed', 'failure'), push('completed', 'cancelled')]]);
    expect(run.status).not.toBe(0);
    expect(run.calls).toBe(1);
    expect(run.stdout).toContain('gh workflow run ci.yml --ref v0.5.0');
  });

  it('fails when no CI run appears before the deadline, naming the commit and the re-run command', () => {
    const run = gate([[]], { waitSeconds: '0' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(SHA);
    expect(run.stdout).toContain('gh workflow run ci.yml --ref v0.5.0');
  });

  it('retries a transient API error within the deadline', () => {
    const run = gate(['ERR', [push('completed', 'success')]]);
    expect(run.status).toBe(0);
    expect(run.calls).toBe(2);
  });

  it('fails closed when the API keeps failing until the deadline', () => {
    expect(gate(['ERR'], { waitSeconds: '0' }).status).not.toBe(0);
  });

  it.each(['ahead', 'diverged'])('refuses a commit that is not on main (compare status %s)', (compare) => {
    const run = gate([[push('completed', 'success')]], { compare });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('not on main');
    expect(run.calls).toBe(0);
  });

  it('accepts an older commit of main (compare status behind)', () => {
    expect(gate([[push('completed', 'success')]], { compare: 'behind' }).status).toBe(0);
  });

  it('fails closed when main cannot be compared (unknown commit)', () => {
    expect(gate([[push('completed', 'success')]], { compareExit: 1 }).status).not.toBe(0);
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
