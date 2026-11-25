import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isAllowedThreadDocPath, THREAD_DOC_LIMITS } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../../diagnostics';
import { fieldOf, refused, refuseInvalidInput } from './shared';
import type { ThreadTool, ThreadToolContext, ThreadToolResult } from './types';

const encoder = new TextEncoder();

/** The first existing symlink on `path` (each directory, then the file), relative to `root`; a missing segment ends the walk. */
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

async function write(ctx: ThreadToolContext, input: unknown, turnSignal?: AbortSignal): Promise<ThreadToolResult> {
  if (ctx.sessionSignal?.aborted || turnSignal?.aborted) return refused('write cancelled');
  const path = fieldOf(input, 'path');
  if (typeof path !== 'string' || !isAllowedThreadDocPath(path, ctx.feature ?? '')) {
    // The refused path is echoed back to the agent, so it is capped at the longest path a thread may write.
    const echoed = String(path).slice(0, THREAD_DOC_LIMITS.maxPathChars);
    return refused(sanitizeDiagnostic(`path not allowed: ${echoed}`));
  }
  const content = fieldOf(input, 'content');
  if (typeof content !== 'string') return refused('content must be a string');
  // Each UTF-16 code unit encodes to at least one UTF-8 byte, so a longer string is over the limit: skip encoding it.
  if (content.length > THREAD_DOC_LIMITS.maxFileBytes) return refused('content too large');
  const bytes = encoder.encode(content).byteLength;
  if (bytes > THREAD_DOC_LIMITS.maxFileBytes) return refused('content too large');

  const linked = await symlinkOnPath(ctx.worktree, path);
  if (linked !== null) return refused(`refused symlink: ${linked}`);

  const target = join(ctx.worktree, path);
  // Commit the bounded local write and its stream event in the same turn as the last
  // ownership check. A close cannot hand this worktree to a successor in between.
  if (ctx.sessionSignal?.aborted || turnSignal?.aborted) return refused('write cancelled');
  mkdirSync(dirname(target), { recursive: true });
  const root = realpathSync(ctx.worktree);
  const parent = realpathSync(dirname(target));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) return refused('path escapes the worktree');

  const fd = openSync(target, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return refused('not a regular file');
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, 'utf8');
  } finally {
    closeSync(fd);
  }
  ctx.onDocWritten?.(path, bytes);
  return { content: `wrote ${path} (${bytes} bytes)` };
}

/**
 * Writes an allowlisted markdown file into the worktree. Nothing is committed: the file stays untracked or modified
 * until Publish. Each refusal is an isError result, and a refused call writes nothing.
 */
export function writeDocTool(ctx: ThreadToolContext): ThreadTool {
  return {
    name: 'write_doc',
    description: 'Write a markdown file under docs/ or the thread feature\'s .nax/features/<feature>/ directory. The file is not committed; publishing the thread commits it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path of an allowlisted .md file.' },
        content: { type: 'string', description: 'The full UTF-8 text of the file; replaces an existing file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    approval: 'never',
    run: (input, context) => refuseInvalidInput(() => write(ctx, input, context?.signal)),
  };
}
