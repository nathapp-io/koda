#!/usr/bin/env bun
/**
 * release.ts - prepare and tag a koda release (RELEASING.md). Adapted from nax's release command.
 *
 * From the repo root:
 *   bun run release [--dry-run] <canary|promote|patch|minor|major|X.Y.Z|X.Y.Z-canary.N>
 *     Sets root, api, cli and web to one version, refreshes bun.lock and opens a PR from release/vX.Y.Z.
 *   bun run release [--dry-run] tag
 *     On clean main that matches origin/main, pushes vX.Y.Z; .github/workflows/release.yml then publishes the
 *     CLI to npm and the api and web images to Docker Hub.
 *
 * PR-first: main only changes through a reviewed PR, and pushing the tag is always a separately confirmed step.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { RELEASE_MANIFESTS, readVersions, sharedVersion, writeVersion } from './lib/release-manifests';
import { describeChannels, nextReleaseVersion } from './lib/release-version';

const REPO = resolve(import.meta.dir, '..');
const USAGE = 'Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z|X.Y.Z-canary.N>';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function requireCleanMain(): void {
  if (git('branch', '--show-current') !== 'main') throw new Error('Must be on main to release');
  if (git('status', '--porcelain')) throw new Error('Working tree is dirty; commit or stash changes first');
}

/** origin's commits for `refs/heads/main` and `refs/tags/<tag>`, keyed by the whole ref name. */
function remoteRefs(tag: string): ReadonlyMap<string, string> {
  const refs = new Map<string, string>();
  for (const line of git('ls-remote', 'origin', 'refs/heads/main', `refs/tags/${tag}`).split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

function rejectExistingTag(tag: string): void {
  if (git('tag', '--list', tag)) throw new Error(`Tag ${tag} already exists locally`);
  if (remoteRefs(tag).has(`refs/tags/${tag}`)) throw new Error(`Tag ${tag} already exists on origin`);
}

/** Whether a local tag already sits at `head`; a tag at any other commit is refused. */
function localTagAtHead(tag: string, head: string): boolean {
  if (git('tag', '--list', tag) === '') return false;
  const existing = git('rev-list', '-n', '1', tag);
  if (existing !== head) throw new Error(`Tag ${tag} already exists at ${existing}, not at HEAD`);
  return true;
}

/** Refuses a tag origin already holds, or a HEAD that origin/main does not point at. */
function rejectStaleOrigin(tag: string, head: string): void {
  const refs = remoteRefs(tag);
  if (refs.has(`refs/tags/${tag}`)) throw new Error(`Tag ${tag} already exists on origin`);
  const remote = refs.get('refs/heads/main');
  if (remote !== head) {
    throw new Error(
      `Local main ${head} does not match origin/main ${remote ?? '(no such branch)'}; pull or push main before tagging`,
    );
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.once('close', () => resolveAnswer(false));
    rl.question(`${message} [y/N] `, (answer) => {
      resolveAnswer(answer.trim().toLowerCase() === 'y');
      rl.close();
    });
  });
}

function currentVersion(): string {
  return sharedVersion(readVersions(REPO));
}

function openPullRequest(current: string, next: string, branch: string): void {
  const temp = mkdtempSync(join(tmpdir(), 'koda-release-'));
  try {
    const bodyFile = join(temp, 'pr-body.md');
    writeFileSync(
      bodyFile,
      [
        `Sets the release version ${current} -> ${next} in:`,
        ...RELEASE_MANIFESTS.map((manifest) => `- \`${manifest}\``),
        '- `bun.lock` (workspace versions)',
        '',
        `Publishes: ${describeChannels(next)}`,
        '',
        'After review and merge, on clean main from the repo root:',
        '',
        '```sh',
        'bun run release --dry-run tag',
        'bun run release tag',
        '```',
        '',
      ].join('\n'),
    );
    execFileSync(
      'gh',
      ['pr', 'create', '--title', `chore: release v${next}`, '--body-file', bodyFile, '--base', 'main', '--head', branch],
      { cwd: REPO, stdio: 'inherit' },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function bumpRelease(kind: string, dryRun: boolean): Promise<void> {
  const current = currentVersion();
  const next = nextReleaseVersion(current, kind);
  const tag = `v${next}`;
  const branch = `release/${tag}`;
  console.log([`koda: ${current} -> ${next}`, `Tag: ${tag}`, `Branch: ${branch}`, `Publishes: ${describeChannels(next)}`].join('\n'));
  if (dryRun) {
    console.log('Dry run; no changes made.');
    return;
  }
  requireCleanMain();
  rejectExistingTag(tag);
  if (!(await confirm('Prepare and push the release PR? This does not publish.'))) {
    console.log('Aborted.');
    return;
  }
  git('pull', '--ff-only', 'origin', 'main');
  requireCleanMain();
  if (currentVersion() !== current) throw new Error('The version changed after pull; rerun to review the new plan');
  git('checkout', '-b', branch);
  writeVersion(REPO, next);
  execFileSync('bun', ['install'], { cwd: REPO, stdio: 'inherit' });
  git('add', 'bun.lock', ...RELEASE_MANIFESTS);
  git('commit', '-m', `chore: release ${tag}`);
  git('push', '-u', 'origin', branch);
  openPullRequest(current, next, branch);
  git('checkout', 'main');
  console.log('Review and merge the PR, then run `bun run release tag` on clean main.');
}

async function tagRelease(dryRun: boolean): Promise<void> {
  requireCleanMain();
  const version = currentVersion();
  const tag = `v${version}`;
  const head = git('rev-parse', 'HEAD');
  localTagAtHead(tag, head);
  console.log(`${tag} at ${head}\nPublishes: ${describeChannels(version)}`);
  if (dryRun) {
    console.log('Dry run; no tag created or pushed.');
    return;
  }
  if (!(await confirm(`Push ${tag}? This publishes to npm and Docker Hub.`))) {
    console.log('Aborted.');
    return;
  }
  // The prompt waits for input, so another terminal can commit meanwhile. Revalidate, then create the tag at,
  // and deliver, exactly the commit origin/main was checked against.
  const verified = git('rev-parse', 'HEAD');
  if (verified !== head) throw new Error(`HEAD moved from ${head} to ${verified} while waiting; rerun to review it`);
  const existing = localTagAtHead(tag, verified);
  rejectStaleOrigin(tag, verified);
  if (!existing) git('tag', tag, verified);
  git('push', 'origin', `${verified}:refs/tags/${tag}`);
  console.log(`Pushed ${tag}; watch https://github.com/nathapp-io/koda/actions/workflows/release.yml`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const kinds = args.filter((arg) => arg !== '--dry-run');
  if (kinds.length !== 1) throw new Error(USAGE);
  const kind = kinds[0] ?? '';
  if (kind === 'tag') await tagRelease(dryRun);
  else await bumpRelease(kind, dryRun);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
