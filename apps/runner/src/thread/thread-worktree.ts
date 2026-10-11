import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { GitError, reasonFromError, type Git } from '../executor/git';
import { GIT_REF_RE } from '../executor/refs';
import { ensureClone } from '../executor/workspace';
import { assertFeature, assertSegment } from '../paths/safe-segment';
import type { RepoMutex } from '../supervisor/repo-mutex';
import { threadDirFor, threadMetaPath, threadWorktreeDir } from './thread-paths';

export type ThreadWorktreeResult = { ok: true; worktree: string; tipSha: string } | { ok: false; reason: string };

/** The repository a thread belongs to; a caller may name it instead of a commit author. */
export interface ThreadRepoIdentity {
  readonly owner: string;
  readonly repo: string;
}

/** What a fresh clone records as its author: the job's `gitIdentity`, or the repository it belongs to. */
export type ThreadWorktreeIdentity = GitIdentity | ThreadRepoIdentity;

export interface PrepareThreadWorktreeInput {
  readonly git: Git;
  readonly mutex: Pick<RepoMutex, 'acquire'>;
  readonly repoKey: string;
  readonly repoDir: string;
  readonly cloneUrl: string;
  readonly identity: ThreadWorktreeIdentity;
  readonly credentialHelper?: string | null;
  readonly homeDir: string;
  readonly threadId: string;
  readonly baseRef: string;
  readonly feature: string;
}

export interface PruneArchivedThreadsInput {
  readonly git: Git;
  readonly homeDir: string;
  readonly threadIds: readonly string[];
  readonly activeThreadIds: readonly string[];
}

const LOCK_REASON = 'koda-thread';
const REF_LOCK_ERROR = /cannot lock ref|unable to lock/;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

const isClone = (repoDir: string): Promise<boolean> => exists(join(repoDir, '.git'));

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A sha, or null when the ref does not resolve. Git refusing a ref is a fact about the clone, not a failure. */
async function refSha(git: Git, repoDir: string, ref: string): Promise<string | null> {
  const sha = await git.ok(['rev-parse', '--verify', '--end-of-options', ref], { cwd: repoDir }).catch(() => null);
  return sha?.trim() || null;
}

type Tip = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string };

/** Design §2 step 3, in `resolveRef`'s order: the local feature branch, then origin/<baseRef>, then the ref itself. */
async function resolveTip(git: Git, repoDir: string, feature: string, baseRef: string): Promise<Tip> {
  const local = await refSha(git, repoDir, `refs/heads/feat/${feature}`);
  if (local) return { ok: true, sha: local };
  if (!GIT_REF_RE.test(baseRef)) return { ok: false, reason: 'checkout: invalid ref' };
  const remote = await refSha(git, repoDir, `refs/remotes/origin/${baseRef}`);
  if (remote) return { ok: true, sha: remote };
  const other = await refSha(git, repoDir, `${baseRef}^{commit}`);
  return other ? { ok: true, sha: other } : { ok: false, reason: 'checkout: ref not found' };
}

/** A concurrent fetch holds the ref lock; one retry rides it out (D86 keeps the rest of the rules unchanged). */
async function fetchOrigin(git: Git, repoDir: string, credentialHelper: string | null): Promise<void> {
  const args = ['fetch', 'origin'];
  const first = await git.run(args, { cwd: repoDir, credentialHelper });
  if (first.code === 0) return;
  if (!REF_LOCK_ERROR.test(first.stderr)) throw new GitError(args, first);
  const retry = await git.run(args, { cwd: repoDir, credentialHelper });
  if (retry.code !== 0) throw new GitError(args, retry);
}

/** Only a path's dirname can be realpathed: a registered worktree whose directory is gone still has one. */
async function normalizeWorktreePath(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute)).catch(() => dirname(absolute));
  return join(parent, basename(absolute));
}

async function listWorktrees(git: Git, repoDir: string): Promise<Set<string>> {
  const listed = await git.run(['worktree', 'list', '--porcelain'], { cwd: repoDir });
  if (listed.code !== 0) throw new GitError(['worktree', 'list', '--porcelain'], listed);
  const paths = listed.stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
  return new Set(await Promise.all(paths.map(normalizeWorktreePath)));
}

/** Design §2 step 5: register the worktree, keep it locked, and detach it at the tip. */
async function placeWorktree(git: Git, repoDir: string, wt: string, tipSha: string): Promise<string | null> {
  const registered = await listWorktrees(git, repoDir);
  const key = await normalizeWorktreePath(wt);
  const present = await exists(wt);
  if (registered.has(key) && !present) await git.ok(['worktree', 'remove', '--force', '--force', wt], { cwd: repoDir });
  if (!registered.has(key) || !present) {
    await rm(wt, { recursive: true, force: true });
    await git.ok(['worktree', 'add', '--detach', '--lock', '--reason', LOCK_REASON, wt, tipSha], { cwd: repoDir });
  }
  const checkout = await git.run(['checkout', '--detach', tipSha], { cwd: wt });
  return checkout.code === 0 ? null : 'worktree_conflict';
}

async function writeThreadMeta(homeDir: string, threadId: string, repoDir: string): Promise<void> {
  await mkdir(threadDirFor(homeDir, threadId), { recursive: true });
  await writeFile(threadMetaPath(homeDir, threadId), JSON.stringify({ repoDir }));
}

/** `ensureClone` writes `user.name` / `user.email`; a repository identity carries no commit author. */
function commitIdentity(identity: ThreadWorktreeIdentity): GitIdentity | undefined {
  return 'email' in identity ? { name: identity.name, email: identity.email } : undefined;
}

/**
 * Design §2 step 1: a missing clone is created under the repository mutex, an existing one is left alone —
 * neither its `user.*` nor its `credential.helper` configuration is rewritten (D85).
 */
async function ensureRepoClone(input: PrepareThreadWorktreeInput, credentialHelper: string | null): Promise<void> {
  if (await isClone(input.repoDir)) return;
  const release = await input.mutex.acquire(input.repoKey);
  try {
    if (!(await isClone(input.repoDir))) {
      await ensureClone(input.git, { repoDir: input.repoDir, cloneUrl: input.cloneUrl, identity: commitIdentity(input.identity), credentialHelper });
    }
  } finally {
    release();
  }
}

/** Design §2 steps 1-5: refresh the clone, then hand the thread its own locked, detached worktree. */
export async function prepareThreadWorktree(input: PrepareThreadWorktreeInput): Promise<ThreadWorktreeResult> {
  const feature = assertFeature(input.feature);
  const threadId = assertSegment('threadId', input.threadId);
  const credentialHelper = input.credentialHelper ?? null;
  try {
    await ensureRepoClone(input, credentialHelper);
    await fetchOrigin(input.git, input.repoDir, credentialHelper);
    const tip = await resolveTip(input.git, input.repoDir, feature, input.baseRef);
    if (!tip.ok) return { ok: false, reason: tip.reason };
    const wt = threadWorktreeDir(input.homeDir, threadId);
    await writeThreadMeta(input.homeDir, threadId, input.repoDir);
    const conflict = await placeWorktree(input.git, input.repoDir, wt, tip.sha);
    return conflict === null ? { ok: true, worktree: wt, tipSha: tip.sha } : { ok: false, reason: conflict };
  } catch (error) {
    return { ok: false, reason: reasonFromError(error) };
  }
}

/** `<homeDir>/threads/<id>/thread.json` names the clone this thread's worktree is registered in. */
async function registeredRepoDir(homeDir: string, threadId: string): Promise<string | null> {
  const meta = await readJson(threadMetaPath(homeDir, threadId));
  const repoDir = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>).repoDir : undefined;
  if (typeof repoDir !== 'string' || !isAbsolute(repoDir) || !(await isClone(repoDir))) return null;
  return repoDir;
}

/** Remove everything a thread left behind, keeping its directory: a caller may still hold that path. */
async function emptyThreadDir(dir: string): Promise<void> {
  for (const entry of await readdir(dir).catch(() => [])) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Design §2 cleanup: an archived thread keeps no worktree registration and no local file. A directory
 * with no `thread.json` never registered a worktree — a crashed or never-started thread — and is
 * removed whole; a registered thread's directory is emptied in place, so a caller that prepared it
 * still finds the path it was handed.
 */
export async function pruneArchivedThreads(input: PruneArchivedThreadsInput): Promise<void> {
  const active = new Set(input.activeThreadIds);
  for (const candidate of input.threadIds) {
    if (active.has(candidate)) continue;
    let threadId: string;
    try {
      threadId = assertSegment('threadId', candidate);
    } catch {
      continue;
    }
    const dir = threadDirFor(input.homeDir, threadId);
    const repoDir = await registeredRepoDir(input.homeDir, threadId);
    if (!repoDir) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    await input.git.run(['worktree', 'remove', '--force', '--force', threadWorktreeDir(input.homeDir, threadId)], { cwd: repoDir });
    await emptyThreadDir(dir);
  }
}
