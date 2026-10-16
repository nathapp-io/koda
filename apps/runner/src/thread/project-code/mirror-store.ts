import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectRepoAssign } from '@nathapp/fleet-protocol';
import { GitError, type Git, type GitOptions } from '../../executor/git';
import { assertSegment } from '../../paths/safe-segment';
import type { RepoMutex } from '../../supervisor/repo-mutex';

export function projectCodeDirFor(homeDir: string, repoId: string): string {
  return join(homeDir, 'project-code', `${assertSegment('repoId', repoId)}.git`);
}

/** Git's own words when the path is not a repository. `git.ts` pins `LC_ALL=C`, so this is never a translation. */
const NOT_A_REPOSITORY = /not a git repository/;

/** What git says about a path this store owns. See `probeMirror`. */
export type MirrorState = 'bare' | 'not-a-mirror';

/**
 * Review B2/B4: a mirror is a repository only when git says so, and git saying *nothing* is not git saying "no".
 *
 * - `bare`: the usable bare mirror this store keeps.
 * - `not-a-mirror`: git read the path and it is not that mirror — never initialized, left half-made by an interrupted
 *   `init`, a working tree, or plain junk. It holds no pin and no session can read it, so replacing it loses nothing.
 *
 * Anything else — a malformed global git config, an unreadable `HEAD`, `objects` or `refs`, a missing `git` —
 * **throws**. That is an operational failure of the machine, not evidence about the mirror: reading it as "invalid"
 * deleted (prune) or re-initialized (refresh) healthy mirrors with live pins (review B4). Fail safe: keep the mirror,
 * report the failure.
 *
 * Git prints "not a git repository" for an unreadable `HEAD`, `objects` or `refs` too, so that message alone is
 * ambiguous: it means `not-a-mirror` only when the filesystem confirms part of the repository skeleton is absent.
 */
export async function probeMirror(git: Git, options: GitOptions): Promise<MirrorState> {
  const probe = await git.run(['rev-parse', '--is-bare-repository'], options);
  if (probe.code === 0) return probe.stdout.trim() === 'true' ? 'bare' : 'not-a-mirror';
  if (NOT_A_REPOSITORY.test(probe.stderr) && (await skeletonIncomplete(options.cwd))) return 'not-a-mirror';
  throw new GitError(['rev-parse', '--is-bare-repository'], probe);
}

const SKELETON = ['HEAD', 'objects', 'refs'] as const;

/**
 * True only when some entry of a bare repository's skeleton is absent. An entry that exists, or that cannot be
 * stat-ed (a permission failure), is no evidence of an interrupted init, so a complete skeleton git still rejects is
 * kept rather than replaced.
 */
async function skeletonIncomplete(cwd: string): Promise<boolean> {
  const present = await Promise.all(SKELETON.map((entry) => lstat(join(cwd, entry)).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  )));
  return present.includes(false);
}

/**
 * Review B2: build the mirror in a staging directory beside it and rename it into place, so the mirror path is
 * either absent or a complete bare repository — never a half-initialized directory that poisons every retry.
 * A path that exists but is not a repository (an interrupted init, a crash between mkdir and init, an older
 * runner's leftovers) is replaced here; the caller holds the mirror's mutex, so nothing else is using it.
 */
async function createBareMirror(git: Git, cwd: string, options: GitOptions): Promise<boolean> {
  const staging = `${cwd}.init-${randomUUID().slice(0, 8)}`;
  try {
    await mkdir(staging, { recursive: true });
    if ((await git.run(['init', '--bare', '-q'], { ...options, cwd: staging })).code !== 0) return false;
    await rm(cwd, { recursive: true, force: true });
    await rename(staging, cwd);
    return true;
  } catch {
    return false;
  } finally {
    // After a successful rename the staging path is gone; after a failure it must not be left beside the mirror.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface RefreshMirrorInput {
  git: Git;
  mutex: Pick<RepoMutex, 'acquire'>;
  homeDir: string;
  repo: ProjectRepoAssign;
  credentialHelper: string | null;
  timeoutMs: number;
  nowMs: () => number;
  allowFileProtocol?: boolean;
  pinId: string;
}

export type RefreshMirrorResult = { ok: true; sha: string } | { ok: false; reason: 'fetch timeout' | 'fetch failed' };

/** Refresh and pin atomically with respect to both other sessions and the mirror prune. */
export async function refreshMirror(input: RefreshMirrorInput): Promise<RefreshMirrorResult> {
  const cwd = projectCodeDirFor(input.homeDir, input.repo.repoId);
  const pinId = assertSegment('pinId', input.pinId);
  const release = await input.mutex.acquire(`project-code:${input.repo.repoId}`);
  try {
    const options = { cwd, timeoutMs: input.timeoutMs, env: { GIT_CONFIG_NOSYSTEM: '1' } };
    const existing = await lstat(cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.isDirectory()) return { ok: false, reason: 'fetch failed' };
    // Review B2/B4: the directory existing is not enough — git must be able to read it as a bare repository, or the
    // fetch below fails forever in a path no retry ever repairs. A probe failure that is *not* git rejecting the path
    // throws (probeMirror), the catch below reports `fetch failed`, and the mirror with its pins stays untouched.
    const state = existing ? await probeMirror(input.git, options) : 'not-a-mirror';
    if (state === 'not-a-mirror' && !(await createBareMirror(input.git, cwd, options))) return { ok: false, reason: 'fetch failed' };
    const started = input.nowMs();
    const fetched = await input.git.run([
      '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0',
      '-c', `protocol.file.allow=${input.allowFileProtocol === true ? 'always' : 'never'}`,
      'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', input.repo.cloneUrl,
      `+refs/heads/${input.repo.defaultBranch}:refs/koda/tip`,
    ], { ...options, credentialHelper: input.credentialHelper });
    if (fetched.code !== 0) return { ok: false, reason: input.nowMs() - started >= input.timeoutMs ? 'fetch timeout' : 'fetch failed' };
    const tip = await input.git.run(['rev-parse', 'refs/koda/tip'], options);
    const sha = tip.stdout.trim();
    if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, reason: 'fetch failed' };
    const pinned = await input.git.run(['update-ref', `refs/koda/pins/${pinId}`, sha], options);
    if (pinned.code !== 0) return { ok: false, reason: 'fetch failed' };
    await writeFile(join(cwd, 'koda-last-used'), String(input.nowMs()));
    return { ok: true, sha };
  } catch {
    // Filesystem/spawn failures are operational fetch failures, not a successful pin.
    return { ok: false, reason: 'fetch failed' };
  } finally {
    release();
  }
}
