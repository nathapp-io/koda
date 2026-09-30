/** A stand-in for `gh` (plan 3b-1 Task 6): logs what it was given, answers `pr create` with a PR URL. */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env['FAKE_GH_LOG'];
if (log) {
  appendFileSync(log, `${JSON.stringify({ argv: args, ghToken: process.env['GH_TOKEN'] ?? null, ghHost: process.env['GH_HOST'] ?? null, path: process.env['PATH'] ?? '' })}\n`);
}
if (args[0] === '--version') console.log('gh version 0.0.0-fake');
else if (args[0] === 'pr' && args[1] === 'create') console.log(process.env['FAKE_GH_PR_URL'] ?? 'https://example.test/koda/pull/7');
process.exit(Number(process.env['FAKE_GH_EXIT'] ?? 0));
