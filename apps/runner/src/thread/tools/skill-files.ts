import type { Stats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
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

function unknownSkill(ctx: ThreadToolContext, name: string): ThreadToolResult {
  const available = ctx.skills.flatMap((source) => source.skills.map((skill) => skill.name));
  return refused(`unknown skill ${name}; available: ${available.join(', ')}`);
}

/**
 * Reads one file under a skill directory. Refused: a symbolic link on the path, a target that resolves outside
 * the skill directory, a file above 262144 bytes, and a file that holds a NUL byte or is not UTF-8.
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

  const [realDir, realFile] = await Promise.all([realpath(skillDir), realpath(target)]);
  if (!realFile.startsWith(realDir + sep)) return refused(`skill file ${relPath} resolves outside its skill directory`);
  if (info.size > MAX_SKILL_FILE_BYTES) return refused(`skill file ${relPath} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);

  const bytes = await readFile(target);
  if (bytes.includes(0)) return refused(`skill file ${relPath} is binary: contains a NUL byte`);
  try {
    return { content: utf8.decode(bytes) };
  } catch {
    return refused(`skill file ${relPath} is binary: not valid UTF-8`);
  }
}

/** Reads a file of the named skill; an unknown name is refused with the list of available skills. */
export async function readSkill(ctx: ThreadToolContext, name: string, relPath: string): Promise<ThreadToolResult> {
  const skillDir = findSkillDir(ctx, name);
  if (skillDir === undefined) return unknownSkill(ctx, name);
  return readSkillFileText(skillDir, relPath);
}
