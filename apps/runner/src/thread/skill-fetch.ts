import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertOwner, assertRelativePath, assertSegment } from '../paths/safe-segment';
import { skillCacheDirFor } from './thread-paths';

export interface SkillSource {
  sourceId: string;
  owner: string;
  repo: string;
  sha: string;
  dir: string;
}

export interface SkillGit {
  run(args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<void>;
}

export interface EnsureSkillsOptions {
  skills: SkillSource[];
  skillsRoot: string;
  git: SkillGit;
  timeoutMs: number;
  origin?: string;
  maxTreeBytes?: number;
}

export type EnsureSkillsResult = { ok: true } | { ok: false; reason: 'skill_fetch_failed' };

const COMPLETE_MARKER = '.koda-complete';
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
const SHA_RE = /^[0-9a-f]{40}$/;

function validateSource(source: SkillSource): void {
  assertSegment('sourceId', source.sourceId);
  assertOwner(source.owner);
  assertSegment('repo', source.repo);
  if (!SHA_RE.test(source.sha)) throw new Error('invalid sha');
  assertRelativePath('skill dir', source.dir);
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export async function ensureSkills(options: EnsureSkillsOptions): Promise<EnsureSkillsResult> {
  const { skills, skillsRoot, git, timeoutMs } = options;
  try {
    skills.forEach(validateSource);
  } catch {
    return { ok: false, reason: 'skill_fetch_failed' };
  }

  const origin = options.origin ?? 'https://github.com';
  const maxTreeBytes = options.maxTreeBytes ?? 52_428_800;
  try {
    for (const source of skills) {
      const target = skillCacheDirFor(skillsRoot, source.sourceId, source.sha);
      const marker = join(target, COMPLETE_MARKER);
      if (await lstat(marker).then((item) => item.isFile(), () => false)) {
        const now = new Date();
        await utimes(target, now, now);
        continue;
      }

      const parent = dirname(target);
      await mkdir(parent, { recursive: true });
      const temporary = await mkdtemp(join(parent, `.${source.sha}-`));
      try {
        await git.run(['init'], { cwd: temporary, env: GIT_ENV, timeoutMs });
        await git.run([
          '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', 'fetch', '--depth', '1',
          '--no-recurse-submodules', `${origin.replace(/\/$/, '')}/${source.owner}/${source.repo}`, source.sha,
        ], { cwd: temporary, env: GIT_ENV, timeoutMs });
        await git.run(['checkout', '--detach', source.sha], { cwd: temporary, env: GIT_ENV, timeoutMs });
        await rm(join(temporary, '.git'), { recursive: true, force: true });
        if (await treeBytes(temporary) > maxTreeBytes) throw new Error('skill tree too large');
        await writeFile(join(temporary, COMPLETE_MARKER), '', { flag: 'wx' });

        try {
          await rename(temporary, target);
        } catch (error) {
          if (await lstat(target).then((item) => item.isDirectory(), () => false)) {
            await rm(temporary, { recursive: true, force: true });
          } else {
            throw error;
          }
        }
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    return { ok: true };
  } catch {
    // Remove a source directory created for a failed first fetch, but preserve existing snapshots.
    for (const source of skills) {
      const sourceDir = join(resolve(skillsRoot), source.sourceId);
      await rmdir(sourceDir).catch(() => undefined);
    }
    return { ok: false, reason: 'skill_fetch_failed' };
  }
}

export async function pruneSkillCache(skillsRoot: string, now: Date, maxAgeDays = 30): Promise<void> {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const sourceEntries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  for (const sourceEntry of sourceEntries) {
    if (!sourceEntry.isDirectory()) continue;
    const sourcePath = join(skillsRoot, sourceEntry.name);
    const snapshots = await readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    for (const snapshot of snapshots) {
      if (!snapshot.isDirectory()) continue;
      const snapshotPath = join(sourcePath, snapshot.name);
      const modified = await lstat(snapshotPath).then((item) => item.mtimeMs, () => now.getTime());
      if (modified < cutoff) await rm(snapshotPath, { recursive: true, force: true });
    }
  }
}
