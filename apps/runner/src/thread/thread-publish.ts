import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitIdentity, ThreadPublishFailReason } from '@nathapp/fleet-protocol';
import { isAllowedThreadDocPath } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../diagnostics';
import type { Git } from '../executor/git';
import type { RepoMutex } from '../supervisor/repo-mutex';
import { publishedLineFits } from './thread-published-line';

export const PUBLISH_GIT_TIMEOUT_MS = 60_000;
const ZERO_SHA = '0'.repeat(40);

export interface PublishThreadDocsInput {
  readonly git: Git;
  readonly mutex: Pick<RepoMutex, 'acquire' | 'isLocked'>;
  readonly repoKey: string;
  readonly worktree: string;
  readonly feature: string;
  readonly threadId: string;
  readonly title: string;
  readonly identity: GitIdentity;
}
export type PublishThreadDocsResult =
  | { ok: true; sha: string; paths: string[]; ignored: string[]; specPresent: boolean }
  | { ok: false; reason: ThreadPublishFailReason; detail?: string };

const detailOf = (error: unknown): string => sanitizeDiagnostic(error instanceof Error ? error.message : String(error));

export async function publishThreadDocs(input: PublishThreadDocsInput): Promise<PublishThreadDocsResult> {
  const { git, worktree } = input;
  const options = { cwd: worktree, timeoutMs: PUBLISH_GIT_TIMEOUT_MS } as const;
  try {
    await lstat(join(worktree, '.git'));
    const [topLevel, worktreeReal] = await Promise.all([
      git.ok(['rev-parse', '--show-toplevel'], options),
      realpath(worktree),
    ]);
    if (resolve(topLevel.trim()) !== worktreeReal) return { ok: false, reason: 'no_worktree' };
  } catch {
    return { ok: false, reason: 'no_worktree' };
  }

  if (input.mutex.isLocked(input.repoKey)) return { ok: false, reason: 'repo_busy' };
  const release = await input.mutex.acquire(input.repoKey);
  try {
    const status = await git.ok(['status', '--porcelain', '-z', '--untracked-files=all'], options);
    const entries = status.split('\0');
    const dirty: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      dirty.push(entry.slice(3));
      if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C' || entry[1] === 'C') index += 1;
    }

    const paths: string[] = [];
    const ignored: string[] = [];
    for (const path of dirty) {
      let regular = false;
      if (isAllowedThreadDocPath(path, input.feature)) {
        try { regular = (await lstat(join(worktree, path))).isFile(); } catch { regular = false; }
      }
      (regular ? paths : ignored).push(path);
    }
    paths.sort();
    ignored.sort();

    const head = (await git.ok(['rev-parse', 'HEAD'], options)).trim();
    const ref = `refs/heads/feat/${input.feature}`;
    const existing = await git.run(['show-ref', '--verify', '--quiet', ref], options);
    let current: string | null;
    if (existing.code === 0) current = (await git.ok(['rev-parse', ref], options)).trim();
    else if (existing.code === 1) current = null;
    else throw new Error(existing.stderr || `git show-ref failed (exit ${existing.code})`);
    if (current !== null && current !== head) return { ok: false, reason: 'branch_moved' };
    // `published` is a single protocol line: refuse an unreportable result before changing HEAD or its feature ref.
    if (!publishedLineFits(paths, ignored)) {
      return { ok: false, reason: 'git_error', detail: 'publication result exceeds thread stream line limit' };
    }

    let sha = head;
    if (paths.length === 0) {
      if (current === null) {
        const updated = await git.run(['update-ref', ref, head, ZERO_SHA], options);
        if (updated.code !== 0) throw new Error(updated.stderr || `git update-ref failed (exit ${updated.code})`);
      }
    } else {
      await git.ok(['add', '--', ...paths], options);
      const { name, email } = input.identity;
      const title = input.title.replace(/[\r\n]/g, ' ').slice(0, 200);
      const message = `docs(${input.feature}): spec from koda thread "${title}"\n\nKoda-Thread: ${input.threadId}`;
      await git.ok(['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message, '--', ...paths], {
        ...options,
        env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
      });
      const newSha = (await git.ok(['rev-parse', 'HEAD'], options)).trim();
      const updated = await git.run(['update-ref', ref, newSha, current ?? ZERO_SHA], options);
      if (updated.code !== 0) {
        const reset = await git.run(['reset', '--soft', head], options);
        if (reset.code !== 0) throw new Error(reset.stderr || `git reset failed (exit ${reset.code})`);
        return { ok: false, reason: 'branch_moved' };
      }
      sha = newSha;
    }

    const spec = await git.run(['cat-file', '-e', `${sha}:.nax/features/${input.feature}/spec.md`], options);
    return { ok: true, sha, paths, ignored, specPresent: spec.code === 0 };
  } catch (error) {
    return { ok: false, reason: 'git_error', detail: detailOf(error) };
  } finally {
    release();
  }
}
