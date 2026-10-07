import type { ConfigFileEdit } from '@nathapp/fleet-protocol';
import type { Git } from '../git';

/** The object id at HEAD for `path`, or null when the path is absent. A directory yields its tree id, which never equals a blob id. */
export async function currentBlob(git: Git, repoDir: string, path: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `HEAD:${path}`], { cwd: repoDir });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** S3-5: an edit conflicts when the file at HEAD is not the version it was loaded at (null = must not exist). */
export async function findConflicts(git: Git, repoDir: string, edits: readonly ConfigFileEdit[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const edit of edits) {
    if ((await currentBlob(git, repoDir, edit.path)) !== edit.baseSha) conflicts.push(edit.path);
  }
  return conflicts;
}
