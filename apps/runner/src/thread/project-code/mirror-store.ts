import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectRepoAssign } from '@nathapp/fleet-protocol';
import type { Git, GitOptions } from '../../executor/git';
import { assertSegment } from '../../paths/safe-segment';
import type { RepoMutex } from '../../supervisor/repo-mutex';

export function projectCodeDirFor(homeDir: string, repoId: string): string {
  return join(homeDir, 'project-code', `${assertSegment('repoId', repoId)}.git`);
}

/**
 * Review B2: a mirror is a repository only when git says so. The directory's existence proves nothing — a daemon
 * killed between `mkdir` and `init`, or an `init` that failed halfway, leaves a directory that every later fetch
 * would fail in forever. `rev-parse` exits non-zero in such a directory (and in a working tree that never was a
 * mirror), so this is the one check that tells a usable mirror from a poisoned path.
 */
export async function isBareMirror(git: Git, options: GitOptions): Promise<boolean> {
  const probe = await git.run(['rev-parse', '--is-bare-repository'], options);
  return probe.code === 0 && probe.stdout.trim() === 'true';
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
    // Review B2: the directory existing is not enough — git must be able to read it as a bare repository, or the
    // fetch below fails forever in a path no retry ever repairs.
    if (!existing || !(await isBareMirror(input.git, options))) {
      if (!(await createBareMirror(input.git, cwd, options))) return { ok: false, reason: 'fetch failed' };
    }
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
