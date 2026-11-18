import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { PathError } from '../paths/safe-segment';
import type { Git } from './git';

const CLONE_SCHEMES = new Set(['https:', 'http:', 'file:']);
/** review-1118 US-001: a plain transport or a local path; admitted only by the test-only injection. */
const LOCAL_SCHEMES = new Set(['http:', 'file:']);
/**
 * review-1118 US-001 post-review: the characters WHATWG and git read identically inside the `scheme://authority` part.
 * A backslash is a path separator to WHATWG but part of the host to git, and `<`, `>`, `"`, `{`, `}`, `|`, `^` and a
 * backtick are percent-encoded by one parser and passed through by the other.
 */
const UNAMBIGUOUS_AUTHORITY = /^[A-Za-z0-9\-._~:%!$&'()*+,;=@[\]]+$/;
/** Whitespace, a control character or a backslash anywhere would change the argument git receives. */
// eslint-disable-next-line no-control-regex -- The control characters are the point: they must never reach git.
const AMBIGUOUS_CHARACTER = /[\x00-\x20\x7f\\<>"{}|^`]/;

/** The injected test-only policy: unset, `false` or absent all mean "https only". */
export interface CloneUrlPolicy {
  readonly allowLocalCloneUrls?: boolean;
}

/**
 * review-1118 US-001 post-review: the string handed to git must be the URL the WHATWG parser read. git's own parser
 * treats a missing `//` as a local path or an scp-like remote (`https:/host/x` is a path, `https:host:x` a remote on
 * host `https`), reads a backslash as part of the host, and keeps characters WHATWG percent-encodes.
 */
function isExplicitUrl(url: string, parsed: URL): boolean {
  if (AMBIGUOUS_CHARACTER.test(url) || url.startsWith('-')) return false;
  const prefix = `${parsed.protocol}//`;
  if (url.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  // git splits the authority at the last `@`, like WHATWG, so the two hosts are comparable.
  const authority = url.slice(prefix.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority !== '' && !UNAMBIGUOUS_AUTHORITY.test(authority)) return false;
  const at = authority.lastIndexOf('@');
  const rawHost = at < 0 ? authority : authority.slice(at + 1);
  const rawUserinfo = at < 0 ? '' : authority.slice(0, at);
  // A local file URL legitimately carries no authority (`file:///tmp/x.git`); no other transport may leave the host out.
  if (parsed.protocol === 'file:') return rawUserinfo === '' && (rawHost === '' || rawHost.toLowerCase() === parsed.host.toLowerCase());
  const parsedUserinfo = parsed.username === '' && parsed.password === ''
    ? '' : `${parsed.username}${parsed.password === '' ? '' : `:${parsed.password}`}`;
  return rawHost !== '' && rawHost.toLowerCase() === parsed.host.toLowerCase() && rawUserinfo === parsedUserinfo;
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
  if (!isExplicitUrl(url, parsed)) throw new PathError('invalid cloneUrl');
}

/**
 * review-1118 US-001 post-review: defence in depth at the git invocation itself. `GIT_ALLOW_PROTOCOL` makes the
 * transport list explicit, so a URL that slipped past `assertCloneUrl` still cannot make git dial another transport.
 */
export function transportEnv(allowLocalCloneUrls: boolean): Readonly<Record<string, string>> {
  return { GIT_ALLOW_PROTOCOL: allowLocalCloneUrls ? 'http:https:file' : 'https' };
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
  const env = transportEnv(allowLocalCloneUrls);
  const credentialHelper = input.credentialHelper ?? null;
  const parent = dirname(input.repoDir);
  await mkdir(parent, { recursive: true });
  if (await exists(join(input.repoDir, '.git'))) {
    const current = (await git.ok(['remote', 'get-url', 'origin'], { cwd: input.repoDir })).trim();
    if (current !== input.cloneUrl) await git.ok(['remote', 'set-url', 'origin', input.cloneUrl], { cwd: input.repoDir });
  } else {
    await rm(input.repoDir, { recursive: true, force: true });
    await git.ok(['clone', '--', input.cloneUrl, input.repoDir], { cwd: parent, credentialHelper, fileProtocol, env });
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
  const allowLocalCloneUrls = options.allowLocalCloneUrls === true;
  const fileProtocol = allowLocalCloneUrls ? 'always' : 'never';
  await git.ok(['fetch', '--prune', 'origin'], { cwd: repoDir, credentialHelper, fileProtocol, env: transportEnv(allowLocalCloneUrls) });
  await git.ok(['reset', '--hard', 'HEAD'], { cwd: repoDir });
  await git.ok(['clean', '-ffd'], { cwd: repoDir });
  await git.ok(['worktree', 'prune'], { cwd: repoDir });
}
