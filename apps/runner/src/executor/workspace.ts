import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { PathError } from '../paths/safe-segment';
import type { Git } from './git';

const CLONE_SCHEMES = new Set(['https:', 'http:', 'file:']);

/** D30: only plain transports; no `ext::`, `git://`, ssh or option-shaped values reach `git clone`. */
export function assertCloneUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PathError('invalid cloneUrl');
  }
  if (!CLONE_SCHEMES.has(parsed.protocol) || /\s/.test(url) || url.startsWith('-')) throw new PathError('invalid cloneUrl');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/**
 * D85: the clone's own helper list for nax's git (the finish push): an empty entry resets system and global helpers,
 * then the job's helper. Replaced, never appended, at every prepare; not removed at cleanup.
 */
export async function configureRepoHelper(git: Git, repoDir: string, helper: string): Promise<void> {
  await git.ok(['config', '--local', '--replace-all', 'credential.helper', ''], { cwd: repoDir });
  await git.ok(['config', '--local', '--add', 'credential.helper', helper], { cwd: repoDir });
}

/** Design §2 step 1 with D46: clone on first use, repoint a drifted origin, rebuild a crashed clone. */
export async function ensureClone(git: Git, input: { repoDir: string; cloneUrl: string; identity: GitIdentity; credentialHelper?: string | null }): Promise<void> {
  assertCloneUrl(input.cloneUrl);
  const credentialHelper = input.credentialHelper ?? null;
  const parent = dirname(input.repoDir);
  await mkdir(parent, { recursive: true });
  if (await exists(join(input.repoDir, '.git'))) {
    const current = (await git.ok(['remote', 'get-url', 'origin'], { cwd: input.repoDir })).trim();
    if (current !== input.cloneUrl) await git.ok(['remote', 'set-url', 'origin', input.cloneUrl], { cwd: input.repoDir });
  } else {
    await rm(input.repoDir, { recursive: true, force: true });
    await git.ok(['clone', '--', input.cloneUrl, input.repoDir], { cwd: parent, credentialHelper });
  }
  await git.ok(['config', 'user.name', input.identity.name], { cwd: input.repoDir });
  await git.ok(['config', 'user.email', input.identity.email], { cwd: input.repoDir });
  if (credentialHelper) await configureRepoHelper(git, input.repoDir, credentialHelper);
}

/**
 * Design §2 step 2. `reset --hard HEAD` discards tracked edits (a crashed run's modified prd.json) and never
 * moves the branch; `clean -ffd` has no `-x`, so ignored files such as `checkpoint.jsonl` survive (SP-4).
 */
export async function cleanWorkspace(git: Git, repoDir: string, credentialHelper: string | null = null): Promise<void> {
  await git.ok(['fetch', '--prune', 'origin'], { cwd: repoDir, credentialHelper });
  await git.ok(['reset', '--hard', 'HEAD'], { cwd: repoDir });
  await git.ok(['clean', '-ffd'], { cwd: repoDir });
  await git.ok(['worktree', 'prune'], { cwd: repoDir });
}
