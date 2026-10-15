import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectRepoAssign } from '@nathapp/fleet-protocol';
import type { Git } from '../../executor/git';
import { assertSegment } from '../../paths/safe-segment';
import type { RepoMutex } from '../../supervisor/repo-mutex';

export function projectCodeDirFor(homeDir: string, repoId: string): string {
  return join(homeDir, 'project-code', `${assertSegment('repoId', repoId)}.git`);
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
    if (!existing) {
      await mkdir(cwd, { recursive: true });
      if ((await input.git.run(['init', '--bare', '-q'], options)).code !== 0) return { ok: false, reason: 'fetch failed' };
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
