import type { Git } from '../git';

/** D469: what `nax generate` changed, from porcelain v1 with NUL separators (a rename's source path follows its entry). */
export async function changedFiles(git: Git, repoDir: string, timeoutMs?: number): Promise<string[]> {
  const out = await git.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoDir, ...(timeoutMs ? { timeoutMs } : {}) });
  const tokens = out.split('\0');
  const files = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i] ?? '';
    if (entry.length < 4) continue;
    files.add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i += 1;
  }
  return [...files].sort();
}
