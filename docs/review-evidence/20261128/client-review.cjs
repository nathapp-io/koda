// Run from any directory with node path/to/client-review.cjs after installing repo dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = join(__dirname, '../../..');
const tmp = fs.mkdtempSync(join(tmpdir(), 'koda-client-review-'));
const requests = join(tmp, 'requests.jsonl');

function run(args, expectedCode, { count = 21, score = 0.50 } = {}) {
  fs.writeFileSync(requests, '');
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--require', join(__dirname, 'client-transport.cjs'),
    'src/index.ts', '--cwd', tmp, ...args,
  ], {
    cwd: join(root, 'apps/cli'), encoding: 'utf8', timeout: 30000,
    env: {
      PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(root, 'apps/api/tsconfig.json'),
      KODA_TEST_HOME: tmp, KODA_API_URL: 'http://fixture.invalid', KODA_API_KEY: 'fixture',
      KODA_PROJECT_SLUG: 'sample', REVIEW_REQUESTS: requests, REVIEW_COUNT: String(count), REVIEW_SCORE: String(score),
    },
  });
  if (child.error) throw child.error;
  assert.equal(child.status, expectedCode, child.stderr);
  return { stdout: child.stdout, stderr: child.stderr, calls: fs.readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

try {
  for (const score of [0.50, 0.70, 0.75]) {
    const json = run(['evaluate', '--json'], 0, { score });
    assert.equal(JSON.parse(json.stdout).precisionAt5_avg, score);
    const text = run(['evaluate'], score < 0.70 ? 1 : 0, { score });
    assert.ok(text.stdout.includes(score.toFixed(3)));
  }
  console.log('#10 intended: text exits 1/0/0 at 0.50/0.70/0.75; JSON exits 0 for all.');
  for (const count of [0, 20, 21]) {
    const mine = run(['ticket', 'mine', '--json'], 0, { count });
    assert.equal(JSON.parse(mine.stdout).length, Math.min(count, 20));
    assert.deepEqual(mine.calls, [['GET', '/api/projects/sample/tickets', { assignedTo: 'self' }]]);
  }
  const second = run(['ticket', 'list', '--assigned-to', 'self', '--page', '2', '--json'], 0);
  assert.deepEqual(JSON.parse(second.stdout).map(row => row.number), [21]);
  console.log('#11: zero and 20 assignments complete, 21 silently truncated to 20. ticket list --assigned-to self --page 2 retrieves ticket 21.');
  for (const [identifier, count] of [['agent-slug', 0], ['agent-id', 0], ['user-id', 1], ['self', 20]]) {
    const result = run(['ticket', 'list', '--assigned-to', identifier, '--json'], 0);
    assert.equal(result.calls[0][2].assignedTo, identifier);
    assert.equal(JSON.parse(result.stdout).length, count);
  }
  console.log('#12: slug and agent ID match zero, user ID matches user-owned row, self resolves agent ownership.');
  for (const flags of [[], ['--json']]) {
    const result = run(['label', 'delete', '--id', 'label-id', ...flags], 0);
    assert.deepEqual(result.calls, [['DELETE', '/api/projects/sample/labels/label-id', {}]]);
    assert.equal(result.stdout.trim(), "Label 'label-id' deleted.");
    assert.throws(() => JSON.parse(result.stdout), SyntaxError);
  }
  console.log('#18: successful DELETE 204 prints the same prose with and without --json.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
