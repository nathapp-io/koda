import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { GitError, reasonFromError, type Git } from '../executor/git';
import { GIT_REF_RE } from '../executor/refs';
import { ensureClone } from '../executor/workspace';
import { assertFeature, assertSegment } from '../paths/safe-segment';
import type { RepoMutex } from '../supervisor/repo-mutex';
import { threadDirFor, threadMetaPath, threadWorktreeDir } from './thread-paths';

/**
 * `stale` is true when the existing worktree could not move to the branch tip because its local changes or
 * untracked files would be overwritten: the worktree stays as it was and `tipSha` is its HEAD, the sha the
 * session starts on until a Discard re-detaches it.
 */
export type ThreadWorktreeResult =
  | { ok: true; worktree: string; tipSha: string; stale: boolean }
  | { ok: false; reason: string };

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
  /** The clone a pruned thread's worktree is registered in; absent, the thread directory still goes. */
  readonly git?: Git;
  readonly homeDir: string;
  readonly threadIds: readonly string[];
  readonly activeThreadIds: readonly string[];
}

const LOCK_REASON = 'koda-thread';
/** `placeWorktree` locks every worktree, and git withdraws a locked worktree only with `--force` twice. */
const FORCE_LOCKED = ['--force', '--force'] as const;
const REF_LOCK_ERROR = /cannot lock ref|unable to lock/;
/** `createGit` forces `LC_ALL=C`, so git's refusal to overwrite local changes or untracked files reads the same everywhere. */
const WOULD_BE_OVERWRITTEN = /would be overwritten/;

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

/** `createGit` SIGKILLs a child at its timeout; 128 + SIGKILL is the exit code the result then carries. */
const KILLED_EXIT_CODE = 137;

/** Git could not start (a spawn failure) or never reached a verdict (SIGKILL at the timeout). */
function isOperationalFailure(error: unknown): boolean {
  if (error instanceof GitError) return error.result.code === KILLED_EXIT_CODE;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * A sha, or null when git ran and refused the ref — a fact about the clone, not a failure. A git that
 * could not run at all keeps its error, so the caller maps it through `reasonFromError`.
 */
async function refSha(git: Git, repoDir: string, ref: string): Promise<string | null> {
  const sha = await git.ok(['rev-parse', '--verify', '--end-of-options', ref], { cwd: repoDir })
    .catch((error: unknown): null => {
      if (isOperationalFailure(error)) throw error;
      return null;
    });
  return sha?.trim() || null;
}

export type Tip = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string };

/** Design §2 step 3, in `resolveRef`'s order: the local feature branch, then origin/<baseRef>, then the ref itself. */
export async function resolveTip(git: Git, repoDir: string, feature: string, baseRef: string): Promise<Tip> {
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

/** Where a worktree ended up: at the tip, or stale on its own HEAD because the tip would overwrite local work. */
export type WorktreePlacement =
  | { readonly ok: true; readonly tipSha: string; readonly stale: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Design §2 step 5: register the worktree, keep it locked, and detach it at the tip. A checkout that git refuses
 * because local changes or untracked files would be overwritten leaves the worktree untouched and reports its
 * HEAD as a stale start; any other refusal is a conflict.
 */
async function placeWorktree(git: Git, repoDir: string, wt: string, tipSha: string): Promise<WorktreePlacement> {
  const registered = await listWorktrees(git, repoDir);
  const key = await normalizeWorktreePath(wt);
  const present = await exists(wt);
  if (registered.has(key) && !present) await git.ok(['worktree', 'remove', ...FORCE_LOCKED, wt], { cwd: repoDir });
  if (!registered.has(key) || !present) {
    await rm(wt, { recursive: true, force: true });
    await git.ok(['worktree', 'add', '--detach', '--lock', '--reason', LOCK_REASON, wt, tipSha], { cwd: repoDir });
  }
  const checkout = await git.run(['checkout', '--detach', tipSha], { cwd: wt });
  if (checkout.code === 0) return { ok: true, tipSha, stale: false };
  if (!WOULD_BE_OVERWRITTEN.test(checkout.stderr)) return { ok: false, reason: 'worktree_conflict' };
  const head = (await git.ok(['rev-parse', 'HEAD'], { cwd: wt })).trim();
  return { ok: true, tipSha: head, stale: true };
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
    const placed = await placeWorktree(input.git, input.repoDir, wt, tip.sha);
    return placed.ok ? { ok: true, worktree: wt, tipSha: placed.tipSha, stale: placed.stale } : { ok: false, reason: placed.reason };
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

/**
 * Withdraw one thread's worktree registration from the clone its `thread.json` names. A worktree that is not
 * registered has nothing to withdraw; one that is goes before its directory, because git cannot remove a
 * worktree whose path is already gone. A git refusal is a verdict about the clone and is raised, never
 * discarded: the caller keeps the thread for the next pass instead of deleting a directory git still claims.
 */
async function withdrawWorktree(git: Git, homeDir: string, threadId: string): Promise<void> {
  const repoDir = await registeredRepoDir(homeDir, threadId);
  if (repoDir === null) return;
  const worktree = threadWorktreeDir(homeDir, threadId);
  if (!(await listWorktrees(git, repoDir)).has(await normalizeWorktreePath(worktree))) return;
  const args = ['worktree', 'remove', ...FORCE_LOCKED, worktree];
  const result = await git.run(args, { cwd: repoDir });
  if (result.code !== 0) throw new GitError(args, result);
}

/**
 * Design §2 cleanup: a thread the server no longer reports keeps no worktree registration and no
 * directory — its `thread.json` names the clone to withdraw the registration from, and the whole
 * `<homeDir>/threads/<id>` tree goes.
 *
 * Every id is attempted: one thread whose registration or directory cannot be withdrawn is kept for the next
 * pass and must not skip the ids after it, so the loop collects failures and re-raises the first at the end.
 */
export async function pruneArchivedThreads(input: PruneArchivedThreadsInput): Promise<void> {
  const active = new Set(input.activeThreadIds);
  const failures: unknown[] = [];
  for (const candidate of input.threadIds) {
    if (active.has(candidate)) continue;
    let threadId: string;
    try {
      threadId = assertSegment('threadId', candidate);
    } catch {
      continue;
    }
    try {
      if (input.git) await withdrawWorktree(input.git, input.homeDir, threadId);
      await rm(threadDirFor(input.homeDir, threadId), { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
