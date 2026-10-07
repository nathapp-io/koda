/** A stand-in for `gh` (plan 3b-1 Task 6): logs what it was given, answers `pr create` with a PR URL. S3: FAKE_GH_CREATE_EXIT fails pr create; pr view prints FAKE_GH_EXISTING_PR_URL or exits 1. */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env['FAKE_GH_LOG'];
if (log) {
  appendFileSync(log, `${JSON.stringify({ argv: args, ghToken: process.env['GH_TOKEN'] ?? null, ghHost: process.env['GH_HOST'] ?? null, path: process.env['PATH'] ?? '' })}\n`);
}
if (args[0] === '--version') console.log('gh version 0.0.0-fake');
else if (args[0] === 'pr' && args[1] === 'create') {
  const fail = process.env['FAKE_GH_CREATE_EXIT'];
  if (fail) {
    console.error('a pull request for this branch already exists');
    process.exit(Number(fail));
  }
  console.log(process.env['FAKE_GH_PR_URL'] ?? 'https://example.test/koda/pull/7');
} else if (args[0] === 'pr' && args[1] === 'view') {
  const existing = process.env['FAKE_GH_EXISTING_PR_URL'];
  if (!existing) {
    console.error('no pull requests found for branch');
    process.exit(1);
  }
  console.log(existing);
}
process.exit(Number(process.env['FAKE_GH_EXIT'] ?? 0));
