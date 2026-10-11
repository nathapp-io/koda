import { join, resolve } from 'node:path';
import { assertSegment } from '../paths/safe-segment';

export function threadDirFor(homeDir: string, threadId: string): string {
  return join(resolve(homeDir), 'threads', assertSegment('threadId', threadId));
}

export function threadWorktreeDir(homeDir: string, threadId: string): string {
  return join(threadDirFor(homeDir, threadId), 'wt');
}

export function threadTranscriptDir(homeDir: string, threadId: string): string {
  return join(threadDirFor(homeDir, threadId), 'transcript');
}

export function threadMetaPath(homeDir: string, threadId: string): string {
  return join(threadDirFor(homeDir, threadId), 'thread.json');
}

export function skillCacheDirFor(skillsRoot: string, sourceId: string, sha: string): string {
  return join(resolve(skillsRoot), assertSegment('sourceId', sourceId), assertSegment('sha', sha));
}
