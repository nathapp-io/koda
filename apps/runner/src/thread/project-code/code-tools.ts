import type { EmbedderTool } from '@nathapp/nax-agent';
import type { Git, GitResult } from '../../executor/git';
import { firstLine } from '../../errors';
import { assertRelativePath } from '../../paths/safe-segment';
import { checkGlob, fieldOf, InvalidToolInput, joinCapped, refused, refuseInvalidInput } from '../tools/shared';
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
const SEARCH_MAX_BYTES = 65_536;
const MAX_PATTERN_CHARS = 1_000;
const DEFAULT_MAX_HITS = 200;
const MAX_HITS_LIMIT = 200;
/** A NUL in this many leading characters marks the content binary. */
const BINARY_SCAN_CHARS = 8_000;
const SYMLINK_MODE = '120000';

function pinFor(ctx: ProjectCodeToolContext, repo: unknown): ProjectCodePin | undefined {
  return ctx.pins.find((pin) => pin.repo === repo);
}

/** Every git call reads a pin: the mirror as cwd, no system config, and the search timeout. */
function runGit(ctx: ProjectCodeToolContext, pin: ProjectCodePin, args: readonly string[]): Promise<GitResult> {
  return ctx.git.run(args, { cwd: pin.gitDir, env: { GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: ctx.searchTimeoutMs });
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

  const result = await runGit(ctx, pin, ['ls-tree', '-r', '-z', '--name-only', pin.sha]);
  if (result.code !== 0) return refused(firstLine(result.stderr) || `git ls-tree exited ${result.code}`);
  const matcher = glob === undefined ? undefined : new Bun.Glob(glob);
  const entries = result.stdout.split('\0').filter((path) => path.length > 0
    && (dir === undefined || path.startsWith(`${dir}/`))
    && (matcher === undefined || matcher.match(path)));
  const lines = entries.slice(0, LIST_MAX_ENTRIES);
  if (entries.length > LIST_MAX_ENTRIES) lines.push(`[truncated: ${entries.length - LIST_MAX_ENTRIES} more]`);
  return { content: joinCapped(lines, LIST_MAX_BYTES, false) };
}

function checkPattern(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATTERN_CHARS) throw new InvalidToolInput('invalid pattern');
  return value;
}

function checkMax(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_HITS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_HITS_LIMIT) throw new InvalidToolInput('invalid max');
  return value;
}

function checkFixed(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InvalidToolInput('invalid fixed');
  return value;
}

/** One `git grep`: its hit lines (none on exit 1, no match), or the refusal to return to the agent. */
type GrepOutcome = { hits: string[] } | { failed: ThreadToolResult };

async function grepPin(ctx: ProjectCodeToolContext, pin: ProjectCodePin, args: readonly string[], startedAt: number): Promise<GrepOutcome> {
  const result = await runGit(ctx, pin, args);
  if (result.code === 0) return { hits: result.stdout.split('\n').filter((line) => line.length > 0) };
  if (result.code === 1) return { hits: [] };
  if (ctx.nowMs() - startedAt >= ctx.searchTimeoutMs) return { failed: refused('search timed out') };
  return { failed: refused(firstLine(result.stderr) || `git grep exited ${result.code}`) };
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
  const hits: string[] = [];
  for (const pin of targets) {
    // Without a named repo the search walks every pin in order, so a hit line carries its repo.
    const args = ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '--no-color', fixed ? '-F' : '-E', '-e', pattern, pin.sha];
    if (glob !== undefined) args.push('--', `:(glob)${glob}`);
    const outcome = await grepPin(ctx, pin, args, startedAt);
    if ('failed' in outcome) return outcome.failed;
    // grep prefixes each hit with the sha it searched; the repo the caller knows replaces it.
    hits.push(...outcome.hits.map((line) => `${pin.repo}:${line.slice(line.indexOf(':') + 1)}`));
  }
  if (hits.length === 0) return { content: 'no matches' };
  return { content: joinCapped(hits.slice(0, max), SEARCH_MAX_BYTES, hits.length > max) };
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

/** The file's lines: a trailing newline ends the last line rather than opening an empty one. */
function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

async function readFile(ctx: ProjectCodeToolContext, input: unknown): Promise<ThreadToolResult> {
  const pin = pinFor(ctx, fieldOf(input, 'repo'));
  if (pin === undefined) return refused('unknown repo');
  const path = assertRelativePath('path', fieldOf(input, 'path'));
  const startLine = checkStartLine(fieldOf(input, 'startLine'));
  const endLine = checkEndLine(fieldOf(input, 'endLine'));
  if (endLine !== undefined && endLine < startLine) throw new InvalidToolInput('invalid lines');

  const tree = await runGit(ctx, pin, ['ls-tree', '-z', pin.sha, '--', path]);
  if (tree.code !== 0) return refused(firstLine(tree.stderr) || `git ls-tree exited ${tree.code}`);
  const entry = tree.stdout.split('\0').find((line) => line.length > 0);
  if (entry === undefined) return refused('not found');
  const [meta] = entry.split('\t');
  const [mode, type] = meta.split(' ');
  // A symlink is a blob whose content is a path, not a file of the pinned commit.
  if (type !== 'blob' || mode === SYMLINK_MODE) return refused('not a file');

  const blob = await runGit(ctx, pin, ['cat-file', 'blob', `${pin.sha}:${path}`]);
  if (blob.code !== 0) return refused(firstLine(blob.stderr) || `git cat-file exited ${blob.code}`);
  if (blob.stdout.slice(0, BINARY_SCAN_CHARS).includes('\0')) return refused('binary file');

  const lines = splitLines(blob.stdout);
  const total = lines.length;
  // An empty file has no line 1: only the default start defaults to its 0-0 window.
  if (total === 0 ? startLine > 1 : startLine > total) return refused('invalid lines');
  const first = total === 0 ? 0 : startLine;
  const last = total === 0 ? 0 : Math.min(endLine ?? total, total);
  const header = `${pin.repo}:${path}@${pin.sha.slice(0, 7)} lines ${first}-${last} of ${total}`;
  const slice = total === 0 ? [] : lines.slice(first - 1, last);
  return { content: joinCapped([header, ...slice], SEARCH_MAX_BYTES, false) };
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
