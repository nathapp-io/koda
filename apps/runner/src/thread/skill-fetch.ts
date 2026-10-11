import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ThreadSkillSource } from '@nathapp/fleet-protocol';
import type { GitResult } from '../executor/git';
import { assertOwner, assertRelativePath, assertSegment } from '../paths/safe-segment';
import { skillCacheDirFor } from './thread-paths';

export interface SkillGit {
  run(args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<GitResult>;
}

export interface EnsureSkillsOptions {
  skills: ThreadSkillSource[];
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

function validateSource(source: ThreadSkillSource): void {
  assertSegment('sourceId', source.sourceId);
  assertOwner(source.owner);
  assertSegment('repo', source.repo);
  if (!SHA_RE.test(source.sha)) throw new Error('invalid sha');
  // Older thread payloads represented a single skill directory directly on
  // the source. Keep accepting that shape while validating current snapshots.
  const skills = Array.isArray(source.skills)
    ? source.skills
    : typeof (source as ThreadSkillSource & { dir?: unknown }).dir === 'string'
      ? [{ dir: (source as ThreadSkillSource & { dir: string }).dir }]
      : null;
  if (!skills) throw new Error('invalid skills');
  for (const skill of skills) assertRelativePath('skill dir', skill.dir);
}

async function runGit(git: SkillGit, args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<void> {
  const result = await git.run(args, options);
  // Some injected git adapters signal failures by throwing and resolve void on success.
  if (result && result.code !== 0) throw new Error(`git ${args[0] ?? ''} failed with exit ${result.code}`);
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol) ||
      (parsed.protocol !== 'file:' && parsed.hostname.length === 0) ||
      parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('invalid origin');
  }
  const normalized = origin.replace(/\/+$/, '');
  return normalized || (parsed.protocol === 'file:' ? 'file://' : '');
}

/**
 * Deletes every symbolic link in a fetched tree, so nothing that later reads the cache can follow one out of it.
 * readdir does not follow links, so a linked directory is deleted rather than descended into.
 */
async function removeSymlinks(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) await rm(child, { force: true });
    else if (entry.isDirectory()) await removeSymlinks(child);
  }
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

  let origin: string;
  try {
    origin = normalizeOrigin(options.origin ?? 'https://github.com');
  } catch {
    return { ok: false, reason: 'skill_fetch_failed' };
  }
  const maxTreeBytes = options.maxTreeBytes ?? 52_428_800;
  if (!Number.isFinite(maxTreeBytes) || maxTreeBytes < 0) {
    return { ok: false, reason: 'skill_fetch_failed' };
  }
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
        await runGit(git, ['init'], { cwd: temporary, env: GIT_ENV, timeoutMs });
        await runGit(git, [
          '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', 'fetch', '--depth', '1',
          '--no-recurse-submodules', `${origin}/${source.owner}/${source.repo}`, source.sha,
        ], { cwd: temporary, env: GIT_ENV, timeoutMs });
        await runGit(git, ['checkout', '--detach', source.sha], { cwd: temporary, env: GIT_ENV, timeoutMs });
        await rm(join(temporary, '.git'), { recursive: true, force: true });
        await removeSymlinks(temporary);
        if (await treeBytes(temporary) > maxTreeBytes) throw new Error('skill tree too large');
        await writeFile(join(temporary, COMPLETE_MARKER), '');

        try {
          await rename(temporary, target);
        } catch (error) {
          if (await lstat(join(target, COMPLETE_MARKER)).then((item) => item.isFile(), () => false)) {
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
      if (!snapshot.isDirectory() || !SHA_RE.test(snapshot.name)) continue;
      const snapshotPath = join(sourcePath, snapshot.name);
      const modified = await lstat(snapshotPath).then((item) => item.mtimeMs, () => now.getTime());
      if (modified < cutoff) await rm(snapshotPath, { recursive: true, force: true });
    }
    await rmdir(sourcePath).catch(() => undefined);
  }
}
