import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isAllowedNaxPath, type ConfigFileEdit } from '@nathapp/fleet-protocol';

type Applied = { ok: true } | { ok: false; output: string };
const fail = (output: string): Applied => ({ ok: false, output });

/** The first existing symlink on `path` (each directory, then the file), relative to `root`. */
async function symlinkOnPath(root: string, path: string): Promise<string | null> {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) return null;
    if (info.isSymbolicLink()) return relative(root, current);
  }
  return null;
}

/**
 * S3 spec §5 step 3: every path is checked again against the shared allowlist (never `.env`), no existing symlink on
 * the way is followed, and the parent's real path must stay inside the clone.
 */
export async function applyEdits(repoDir: string, edits: readonly ConfigFileEdit[]): Promise<Applied> {
  const root = await realpath(repoDir);
  for (const edit of edits) {
    if (!isAllowedNaxPath(edit.path)) return fail(`path not allowed: ${edit.path}`);
    const link = await symlinkOnPath(root, edit.path);
    if (link !== null) return fail(`refused symlink: ${link}`);
    const target = join(root, edit.path);
    if (edit.op === 'delete') {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) return fail(`path escapes the clone: ${edit.path}`);
    await writeFile(target, edit.content ?? '', 'utf8');
  }
  return { ok: true };
}
