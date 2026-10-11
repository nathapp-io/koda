import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { sanitizeDiagnostic } from '../../diagnostics';
import { assertRelativePath } from '../../paths/safe-segment';
import { skillCacheDirFor } from '../thread-paths';
import { InvalidToolInput, refused } from './shared';
import type { ThreadToolContext, ThreadToolResult } from './types';

const MAX_SKILL_FILE_BYTES = 262_144;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function checkSkillName(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidToolInput('invalid name');
  return value;
}

/** The skill's directory under the cache, from the first source that lists it. */
function findSkillDir(ctx: ThreadToolContext, name: string): string | undefined {
  for (const source of ctx.skills) {
    const skill = source.skills.find((item) => item.name === name);
    if (skill !== undefined) {
      return join(skillCacheDirFor(ctx.skillsRoot, source.sourceId, source.sha), assertRelativePath('skill dir', skill.dir));
    }
  }
  return undefined;
}

/** The model-supplied name is echoed back, so it gets the same cap and redaction as any diagnostic. */
function unknownSkill(ctx: ThreadToolContext, name: string): ThreadToolResult {
  const available = ctx.skills.flatMap((source) => source.skills.map((skill) => skill.name));
  return refused(`unknown skill ${sanitizeDiagnostic(name)}; available: ${available.join(', ')}`);
}

/** Reads the handle's bytes, never more than the cap plus one, so a file that grew after its stat is still bounded. */
async function readBounded(handle: FileHandle): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total > MAX_SKILL_FILE_BYTES ? undefined : buffer.subarray(0, total);
}

/**
 * Reads one file under a skill directory. Refused: a symbolic link on the path, a target that resolves outside
 * the skill directory, a file above 262144 bytes, and a file that holds a NUL byte or is not UTF-8.
 * The file is opened once without following a final symlink, and every later check and read uses that handle.
 */
async function readSkillFileText(skillDir: string, relPath: string): Promise<ThreadToolResult> {
  let target = skillDir;
  let info: Stats | undefined;
  for (const segment of relPath.split('/')) {
    target = join(target, segment);
    info = await lstat(target).catch(() => undefined);
    if (info === undefined) return refused(`skill file ${relPath} not found`);
    if (info.isSymbolicLink()) return refused(`skill file ${relPath} is a symbolic link`);
  }
  if (info === undefined || !info.isFile()) return refused(`skill file ${relPath} is not a regular file`);

  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return refused(`skill file ${relPath} could not be opened`);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return refused(`skill file ${relPath} is not a regular file`);
    if (opened.size > MAX_SKILL_FILE_BYTES) return refused(`skill file ${relPath} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);

    const [realDir, realFile] = await Promise.all([realpath(skillDir), realpath(target)]);
    if (!realFile.startsWith(realDir + sep)) return refused(`skill file ${relPath} resolves outside its skill directory`);

    const bytes = await readBounded(handle);
    if (bytes === undefined) return refused(`skill file ${relPath} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    if (bytes.includes(0)) return refused(`skill file ${relPath} is binary: contains a NUL byte`);
    try {
      return { content: utf8.decode(bytes) };
    } catch {
      return refused(`skill file ${relPath} is binary: not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Reads a file of the named skill; an unknown name is refused with the list of available skills.
 * relPath is validated here, so every caller gets the jail's first layer; an invalid path throws PathError.
 */
export async function readSkill(ctx: ThreadToolContext, name: string, relPath: unknown): Promise<ThreadToolResult> {
  const checked = assertRelativePath('relPath', relPath);
  const skillDir = findSkillDir(ctx, name);
  if (skillDir === undefined) return unknownSkill(ctx, name);
  return readSkillFileText(skillDir, checked);
}
