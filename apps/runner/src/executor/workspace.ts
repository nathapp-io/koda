import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { PathError } from '../paths/safe-segment';
import type { Git } from './git';

const CLONE_SCHEMES = new Set(['https:', 'http:', 'file:']);
/** review-1118 US-001: a plain transport or a local path; admitted only by the test-only injection. */
const LOCAL_SCHEMES = new Set(['http:', 'file:']);

/** The injected test-only policy: unset, `false` or absent all mean "https only". */
export interface CloneUrlPolicy {
  readonly allowLocalCloneUrls?: boolean;
}

/**
 * D30: only plain transports; no `ext::`, `git://`, ssh or option-shaped values reach `git clone`.
 * review-1118 US-001: `http:` and `file:` reach it only behind `allowLocalCloneUrls`, which the daemon never sets
 * in production — a server that shapes an ASSIGN must not point the runner's shared clone at a local path.
 */
export function assertCloneUrl(url: string, options: CloneUrlPolicy = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PathError('invalid cloneUrl');
  }
  const localAllowed = options.allowLocalCloneUrls === true;
  if (!CLONE_SCHEMES.has(parsed.protocol) || (!localAllowed && LOCAL_SCHEMES.has(parsed.protocol)) || /\s/.test(url) || url.startsWith('-')) {
    throw new PathError('invalid cloneUrl');
  }
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

export interface EnsureCloneInput extends CloneUrlPolicy {
  readonly repoDir: string;
  readonly cloneUrl: string;
  readonly identity?: GitIdentity;
  readonly credentialHelper?: string | null;
}

/**
 * Design §2 step 1 with D46: clone on first use, repoint a drifted origin, rebuild a crashed clone.
 * The commit identity is written when the caller has one; without it git's own configuration answers.
 * review-1118 US-001: the URL is checked before any git call, and the clone itself refuses the file transport unless
 * the test-only option admitted the URL in the first place.
 */
export async function ensureClone(git: Git, input: EnsureCloneInput): Promise<void> {
  const allowLocalCloneUrls = input.allowLocalCloneUrls === true;
  assertCloneUrl(input.cloneUrl, { allowLocalCloneUrls });
  const fileProtocol = allowLocalCloneUrls ? 'always' : 'never';
  const credentialHelper = input.credentialHelper ?? null;
  const parent = dirname(input.repoDir);
  await mkdir(parent, { recursive: true });
  if (await exists(join(input.repoDir, '.git'))) {
    const current = (await git.ok(['remote', 'get-url', 'origin'], { cwd: input.repoDir })).trim();
    if (current !== input.cloneUrl) await git.ok(['remote', 'set-url', 'origin', input.cloneUrl], { cwd: input.repoDir });
  } else {
    await rm(input.repoDir, { recursive: true, force: true });
    await git.ok(['clone', '--', input.cloneUrl, input.repoDir], { cwd: parent, credentialHelper, fileProtocol });
  }
  if (input.identity) {
    await git.ok(['config', 'user.name', input.identity.name], { cwd: input.repoDir });
    await git.ok(['config', 'user.email', input.identity.email], { cwd: input.repoDir });
  }
  if (credentialHelper) await configureRepoHelper(git, input.repoDir, credentialHelper);
}

/**
 * Design §2 step 2. `reset --hard HEAD` discards tracked edits (a crashed run's modified prd.json) and never
 * moves the branch; `clean -ffd` has no `-x`, so ignored files such as `checkpoint.jsonl` survive (SP-4).
 * review-1118 US-001: the fetch refuses the file transport unless the test-only option allowed it.
 */
export async function cleanWorkspace(git: Git, repoDir: string, credentialHelper: string | null = null, options: CloneUrlPolicy = {}): Promise<void> {
  const fileProtocol = options.allowLocalCloneUrls === true ? 'always' : 'never';
  await git.ok(['fetch', '--prune', 'origin'], { cwd: repoDir, credentialHelper, fileProtocol });
  await git.ok(['reset', '--hard', 'HEAD'], { cwd: repoDir });
  await git.ok(['clean', '-ffd'], { cwd: repoDir });
  await git.ok(['worktree', 'prune'], { cwd: repoDir });
}
