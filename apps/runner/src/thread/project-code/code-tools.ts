import type { EmbedderTool } from '@nathapp/nax-agent';
import type { Git, GitOptions } from '../../executor/git';
import { runGitRecords } from '../../executor/git-records';
import { firstLine } from '../../errors';
import { assertRelativePath } from '../../paths/safe-segment';
import { CappedLines, checkGlob, fieldOf, FileListing, InvalidToolInput, joinCapped, refused, refuseInvalidInput } from '../tools/shared';
import { checkFixed, checkMax, checkPattern, collectGrep, GREP_ARGS, SEARCH_MAX_BYTES } from '../tools/grep-output';
import type { ThreadToolResult } from '../tools/types';

/** A repository readable through one of its pinned commits, held in a bare mirror at `gitDir`. */
export interface ProjectCodePin {
  /** `owner/name`, as the agent names it. */
  readonly repo: string;
  readonly sha: string;
  readonly gitDir: string;
}

export interface ProjectCodeToolContext {
  readonly pins: readonly ProjectCodePin[];
  readonly unavailable: readonly { readonly repo: string; readonly reason: string }[];
  readonly git: Git;
  readonly searchTimeoutMs: number;
  readonly nowMs: () => number;
}

const LIST_MAX_ENTRIES = 2_000;
const LIST_MAX_BYTES = 262_144;
/** A NUL in this many leading characters marks the content binary. */
const BINARY_SCAN_CHARS = 8_000;
const SYMLINK_MODE = '120000';

function pinFor(ctx: ProjectCodeToolContext, repo: unknown): ProjectCodePin | undefined {
  return ctx.pins.find((pin) => pin.repo === repo);
}

/** Every git call reads a pin: the mirror as cwd, no system config, and the search timeout. */
function gitOptions(ctx: ProjectCodeToolContext, pin: ProjectCodePin): GitOptions {
  return { cwd: pin.gitDir, env: { GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: ctx.searchTimeoutMs };
}

async function listRepos(ctx: ProjectCodeToolContext): Promise<ThreadToolResult> {
  const lines = [
    ...ctx.pins.map((pin) => `${pin.repo} @ ${pin.sha.slice(0, 7)}`),
    ...ctx.unavailable.map((entry) => `${entry.repo} unavailable (${entry.reason})`),
  ];
  return { content: lines.length > 0 ? lines.join('\n') : 'no repositories' };
}

async function listFiles(ctx: ProjectCodeToolContext, input: unknown): Promise<ThreadToolResult> {
  const pin = pinFor(ctx, fieldOf(input, 'repo'));
  if (pin === undefined) return refused('unknown repo');
  const rawDir = fieldOf(input, 'dir');
  const dir = rawDir === undefined ? undefined : assertRelativePath('dir', rawDir);
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);

  const matcher = glob === undefined ? undefined : new Bun.Glob(glob);
  const listing = new FileListing(LIST_MAX_ENTRIES, LIST_MAX_BYTES);
  const result = await runGitRecords(ctx.git, ['ls-tree', '-r', '-z', '--name-only', pin.sha], gitOptions(ctx, pin), {
    delimiter: '\0',
    maxRecordBytes: LIST_MAX_BYTES,
    onRecord(path) {
      if (path === null || (path.length > 0 && (dir === undefined || path.startsWith(`${dir}/`))
        && (matcher === undefined || matcher.match(path)))) listing.add(path);
      return true;
    },
  });
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-tree exited ${result.code}`);
  return { content: listing.content() };
}

async function search(ctx: ProjectCodeToolContext, input: unknown): Promise<ThreadToolResult> {
  const pattern = checkPattern(fieldOf(input, 'pattern'));
  const rawGlob = fieldOf(input, 'glob');
  const glob = rawGlob === undefined ? undefined : checkGlob(rawGlob);
  const max = checkMax(fieldOf(input, 'max'));
  const fixed = checkFixed(fieldOf(input, 'fixed'));
  const rawRepo = fieldOf(input, 'repo');
  const named = rawRepo === undefined ? undefined : pinFor(ctx, rawRepo);
  if (rawRepo !== undefined && named === undefined) return refused('unknown repo');
  const targets = named === undefined ? ctx.pins : [named];

  const startedAt = ctx.nowMs();
  const hits = new CappedLines(SEARCH_MAX_BYTES, max);
  for (const pin of targets) {
    const args = [...GREP_ARGS, fixed ? '-F' : '-E', '-e', pattern, pin.sha];
    if (glob !== undefined) args.push('--', `:(glob)${glob}`);
    // Replace grep's pinned sha with the repository name.
    const failed = await collectGrep(ctx.git, args, gitOptions(ctx, pin), () => ctx.nowMs() - startedAt >= ctx.searchTimeoutMs,
      hits, { from: `${pin.sha}:`, to: `${pin.repo}:` });
    if (failed !== undefined) return failed;
    if (hits.cut) break;
  }
  return { content: hits.lines.length === 0 && !hits.cut ? 'no matches' : hits.content() };
}

function checkStartLine(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new InvalidToolInput('invalid lines');
  return value;
}

function checkEndLine(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new InvalidToolInput('invalid lines');
  return value;
}

async function readFile(ctx: ProjectCodeToolContext, input: unknown): Promise<ThreadToolResult> {
  const pin = pinFor(ctx, fieldOf(input, 'repo'));
  if (pin === undefined) return refused('unknown repo');
  const path = assertRelativePath('path', fieldOf(input, 'path'));
  const startLine = checkStartLine(fieldOf(input, 'startLine'));
  const endLine = checkEndLine(fieldOf(input, 'endLine'));
  if (endLine !== undefined && endLine < startLine) throw new InvalidToolInput('invalid lines');

  const options = gitOptions(ctx, pin);
  const treeEntry: { line: string | null } = { line: null };
  const tree = await runGitRecords(ctx.git, ['ls-tree', '-z', pin.sha, '--', path], options, {
    delimiter: '\0',
    maxRecordBytes: LIST_MAX_BYTES,
    onRecord(line) {
      treeEntry.line = line;
      return false;
    },
  });
  if (tree.code !== 0) return refused(firstLine(tree.stderr) || `git ls-tree exited ${tree.code}`);
  if (!treeEntry.line) return refused('not found');
  const [meta] = treeEntry.line.split('\t');
  const [mode, type] = meta.split(' ');
  // A symlink is a blob whose content is a path, not a file of the pinned commit.
  if (type !== 'blob' || mode === SYMLINK_MODE) return refused('not a file');

  const selected = new CappedLines(SEARCH_MAX_BYTES);
  // UTF-8 needs at most three bytes per UTF-16 code unit, plus a possible BOM.
  const sample = new Uint8Array(BINARY_SCAN_CHARS * 3 + 3);
  let sampleLength = 0;
  let binary = false;
  let total = 0;
  const isBinary = () => new TextDecoder().decode(sample.subarray(0, sampleLength)).slice(0, BINARY_SCAN_CHARS).includes('\0');
  const blob = await runGitRecords(ctx.git, ['cat-file', 'blob', `${pin.sha}:${path}`], options, {
    delimiter: '\n',
    maxRecordBytes: SEARCH_MAX_BYTES,
    onChunk(chunk) {
      if (sampleLength < sample.length) {
        const take = chunk.subarray(0, sample.length - sampleLength);
        sample.set(take, sampleLength);
        sampleLength += take.length;
        if (sampleLength === sample.length) binary = isBinary();
      }
      return !binary;
    },
    onRecord(line) {
      total++;
      if (total >= startLine && (endLine === undefined || total <= endLine) && !selected.cut) selected.add(line);
      return true;
    },
  });
  if (blob.code !== 0) return refused(firstLine(blob.stderr) || `git cat-file exited ${blob.code}`);
  if (binary || (sampleLength < sample.length && isBinary())) return refused('binary file');

  // An empty file has no line 1: only the default start defaults to its 0-0 window.
  if (total === 0 ? startLine > 1 : startLine > total) return refused('invalid lines');
  const first = total === 0 ? 0 : startLine;
  const last = total === 0 ? 0 : Math.min(endLine ?? total, total);
  const header = `${pin.repo}:${path}@${pin.sha.slice(0, 7)} lines ${first}-${last} of ${total}`;
  return { content: joinCapped([header, ...selected.lines], SEARCH_MAX_BYTES, selected.cut) };
}

function listReposTool(ctx: ProjectCodeToolContext): EmbedderTool {
  return {
    name: 'list_repos',
    description: 'List the project repositories this session can read, each with the pinned commit sha it reads, plus every project repository that is unavailable and why.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    approval: 'never',
    run: () => refuseInvalidInput(() => listRepos(ctx)),
  };
}

function listFilesTool(ctx: ProjectCodeToolContext): EmbedderTool {
  return {
    name: 'list_files',
    description: 'List the file paths of a project repository at its pinned commit, optionally under a directory or matching a glob.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as owner/name, from list_repos.' },
        dir: { type: 'string', description: 'Repository-relative directory to list under.' },
        glob: { type: 'string', description: 'Glob pattern for file paths, for example **/*.md.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    approval: 'never',
    run: (input) => refuseInvalidInput(() => listFiles(ctx, input)),
  };
}

function searchRepoTool(ctx: ProjectCodeToolContext): EmbedderTool {
  return {
    name: 'search_repo',
    description: 'Search the pinned commit of one or every project repository for a pattern. Returns owner/name:path:line:text hits.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as owner/name, from list_repos. Absent: search every pinned repository.' },
        pattern: { type: 'string', description: 'Pattern to search for (extended regex unless fixed is true).' },
        glob: { type: 'string', description: 'Restrict the search to paths matching this glob.' },
        max: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum hit lines to return; default 200.' },
        fixed: { type: 'boolean', description: 'Treat pattern as a fixed string.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    approval: 'never',
    run: (input) => refuseInvalidInput(() => search(ctx, input)),
  };
}

function readFileTool(ctx: ProjectCodeToolContext): EmbedderTool {
  return {
    name: 'read_file',
    description: 'Read a line range of a file of a project repository at its pinned commit.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as owner/name, from list_repos.' },
        path: { type: 'string', description: 'Repository-relative file path.' },
        startLine: { type: 'integer', minimum: 1, description: 'First line to return; default 1.' },
        endLine: { type: 'integer', minimum: 1, description: 'Last line to return; default the end of the file.' },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
    approval: 'never',
    run: (input) => refuseInvalidInput(() => readFile(ctx, input)),
  };
}

/**
 * The read-only code tools of a PROJECT session: every repository is read at the pinned sha in its bare mirror,
 * so no checkout and no credential is involved. A repository the session could not prepare is listed, not read.
 */
export function buildProjectCodeTools(ctx: ProjectCodeToolContext): EmbedderTool[] {
  return [listReposTool(ctx), listFilesTool(ctx), searchRepoTool(ctx), readFileTool(ctx)];
}
