/**
 * A stand-in for `nax run` / `nax plan` (slice 3 design §4). Behaviour is chosen by env, see the plan, Task 13.
 * It deliberately mimics the facts the runner depends on: the exit code is not the verdict (a failed run exits 1, a fatal config error exits 0), latest.jsonl appears only at exit,
 * a job profile supplies outputDir, SIGTERM makes nax write run.status = crashed, and `plan` leaves untracked files.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (...names: string[]): string | undefined => {
  for (let i = 0; i < args.length - 1; i += 1) if (names.includes(args[i])) return args[i + 1];
  return undefined;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const git = (...a: string[]): string => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8' }).trim();
const writeAtomic = (path: string, text: string): void => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

if (args[0] === '--version') {
  console.log('0.0.0-fake');
  process.exit(0);
}

const command = args[0];
const feature = flag('-f', '--feature') ?? '';
const jobProfile = (flag('--profile') ?? '').split(',').find((p) => p.startsWith('koda-job-'));
if (!feature || !jobProfile) {
  console.error('fake-nax: needs -f <feature> and a koda-job-* profile in --profile');
  process.exit(2);
}
const naxHome = process.env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
const profile = JSON.parse(readFileSync(join(naxHome, 'profiles', `${jobProfile}.json`), 'utf8')) as { outputDir?: string };
if (!profile.outputDir || !isAbsolute(profile.outputDir)) {
  console.error('fake-nax: the job profile has no absolute outputDir');
  process.exit(2);
}
const outDir = profile.outputDir;
const scenario = process.env['FAKE_NAX_SCENARIO'] ?? (command === 'plan' ? 'plan-valid' : 'completed');
const stepMs = Number(process.env['FAKE_NAX_STEP_MS'] ?? 30);
const steps = Number(process.env['FAKE_NAX_STEPS'] ?? 3);

async function plan(): Promise<void> {
  await sleep(stepMs * steps);
  const dir = join(process.cwd(), '.nax', 'features', feature);
  mkdirSync(join(dir, 'plan'), { recursive: true });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const invalid = scenario === 'plan-invalid';
  const prd = { feature, branchName: process.env['FAKE_NAX_PLAN_BRANCH'] ?? `feat/${feature}`, userStories: invalid ? [] : [{ id: 'US-001', title: 'first story' }] };
  writeFileSync(join(dir, 'prd.json'), JSON.stringify(prd, null, 2));
  if (invalid) {
    writeFileSync(join(dir, 'prd.rejected.json'), JSON.stringify(prd));
  } else {
    const from = flag('--from');
    writeFileSync(join(dir, 'spec.md'), from && existsSync(join(process.cwd(), from)) ? readFileSync(join(process.cwd(), from), 'utf8') : '# spec\n');
    writeFileSync(join(dir, 'prd-fidelity-report.md'), '# fidelity\n');
    writeFileSync(join(dir, 'acceptance-meta.json'), '{"acs":1}');
  }
  writeFileSync(join(dir, 'plan', 'plan-1.jsonl'), '{"msg":"planned"}\n');
  writeFileSync(join(dir, 'sessions', 's1.json'), '{}');
  console.log(`planned ${feature}`);
}

async function run(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `run-${stamp}`;
  const logName = `log-${stamp}.jsonl`;
  const runsDir = join(outDir, 'features', feature, 'runs');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(join(outDir, 'cost'), { recursive: true });
  mkdirSync(join(outDir, 'prompt-audit', feature), { recursive: true });
  writeFileSync(join(outDir, 'prompt-audit', feature, 'p.json'), '{"prompt":"secret prompt text"}');
  const startedAt = new Date().toISOString();
  let passed = 0;
  let spent = 0;
  let finish: Record<string, unknown> | undefined;
  let runStatus = 'running';
  let extra: Record<string, unknown> = {};
  const flush = (): void => writeAtomic(join(outDir, 'status.json'), JSON.stringify({
    version: 1,
    run: { id: runId, feature, workdir: process.cwd(), startedAt, status: runStatus, dryRun: false, pid: process.pid, ...extra },
    progress: { total: steps, passed, failed: 0, paused: 0, blocked: 0, pending: steps - passed },
    cost: { spent, limit: null },
    current: passed < steps ? { storyId: `US-00${passed + 1}`, title: 'story', complexity: 'simple', tddStrategy: 'test-after', model: 'fake', attempt: 1, phase: 'implement' } : null,
    iterations: passed, updatedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), lastHeartbeat: new Date().toISOString(),
    ...(finish ? { postRun: { acceptance: { status: 'not-run' }, regression: { status: 'not-run' }, finish } } : {}),
  }));
  // The handler is registered BEFORE the first flush: a test that waits for status.json and then signals must never
  // hit the default SIGTERM action (D70).
  if (scenario === 'hang') {
    process.on('SIGTERM', () => {
      if (process.env['FAKE_NAX_IGNORE_TERM'] === '1') return;
      runStatus = 'crashed';
      extra = { crashedAt: new Date().toISOString(), crashSignal: 'SIGTERM' };
      flush();
      process.exit(0);
    });
  }
  flush();

  if (scenario === 'hang') {
    setInterval(flush, 100);
    await new Promise<void>(() => undefined);
  }

  for (let i = 1; i <= steps; i += 1) {
    await sleep(stepMs);
    passed = i;
    spent += 0.25;
    flush();
    appendFileSync(join(runsDir, logName), `${JSON.stringify({ level: 'info', msg: `story US-00${i} done` })}\n`);
    appendFileSync(join(outDir, 'cost', `cost-${stamp}.jsonl`), `${JSON.stringify({ runId, amount: 0.25 })}\n`);
    console.log(`story US-00${i} done`);
    console.error(`warn: story ${i}`);
    if (scenario === 'crashed' && i === 1) process.kill(process.pid, 'SIGKILL');
  }
  const gate = process.env['FAKE_NAX_GATE'];
  while (gate && !existsSync(gate)) await sleep(50);

  writeFileSync(join(process.cwd(), `koda-fake-${feature}.txt`), `${runId}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', `feat(${feature}): fake story work`);
  runStatus = scenario === 'failed' ? 'failed' : 'completed';
  if (scenario === 'escalated' || scenario === 'completed') {
    let branch = '';
    try {
      branch = git('symbolic-ref', '--short', '-q', 'HEAD');
    } catch {
      branch = '';
    }
    const opened = scenario === 'completed';
    if (branch && opened) git('push', '-q', '--set-upstream', 'origin', branch);
    if (branch) {
      const ledgerDir = join(outDir, 'finish-audit', feature);
      mkdirSync(ledgerDir, { recursive: true });
      const prUrl = 'https://example.test/koda/pull/1';
      writeFileSync(join(ledgerDir, 'last.json'), JSON.stringify({
        branch, headSha: git('rev-parse', 'HEAD'), status: opened ? 'opened' : 'escalated', ...(opened ? { prUrl } : {}), runId, finishedAt: new Date().toISOString(),
      }));
      finish = opened ? { status: 'passed', result: 'opened', url: prUrl } : { status: 'passed', result: 'escalated', escalationReason: 'fake escalation' };
    } else {
      finish = opened ? { status: 'skipped', reason: 'branch' } : { status: 'passed', result: 'escalated', escalationReason: 'fake escalation' };
    }
  }
  flush();
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ runId, cost: spent }));
  symlinkSync(logName, join(runsDir, 'latest.jsonl'));
}

await (command === 'plan' ? plan() : run());
// Real `nax run` exits 1 when the run failed, 0 otherwise (bin/nax.ts:383); a plan exits 0 here (D70).
process.exit(command !== 'plan' && scenario === 'failed' ? 1 : 0);
