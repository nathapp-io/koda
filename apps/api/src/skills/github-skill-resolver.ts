import { Inject, Injectable } from '@nestjs/common';
import { IVcsConfig, VCS_CFG } from '../config/vcs.config';
import { FleetHttpClient } from '../fleet/git-broker/fleet-http-client';
import { RepoCheckException } from '../fleet/git-broker/repo-check.exception';
import { parseSkillFrontmatter } from './skill-frontmatter';
import { ResolvedSkill, SkillResolution, SkillResolveError, SkillResolveReason, SkillResolver } from './skill-resolver';

const MAX_SKILLS = 50;
const MAX_SKILL_BYTES = 262144;
const SKILL_FILE = 'SKILL.md';
const HEADERS: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number | null;
}

/**
 * Resolves a public github.com source to a pinned commit and its skills with anonymous REST calls (ruling D546).
 * Every failure surfaces as a SkillResolveError with a fixed reason.
 */
@Injectable()
export class GitHubSkillResolver implements SkillResolver {
  constructor(
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl'>,
    private readonly http: FleetHttpClient,
  ) {}

  async resolve({ owner, repo, ref, path }: { owner: string; repo: string; ref: string; path: string }): Promise<SkillResolution> {
    const api = this.vcsConfig.githubApiUrl.replace(/\/+$/, '');
    const repoUrl = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const commit = obj(await this.getOk(`${repoUrl}/commits/${encodePath(ref)}`, { 422: 'ref_not_found' }));
    if (typeof commit.sha !== 'string') throw new SkillResolveError('provider_error');
    const sha = commit.sha;

    const listing = obj(await this.getOk(`${repoUrl}/git/trees/${encodeURIComponent(sha)}?recursive=1`));
    if (listing.truncated === true) throw new SkillResolveError('tree_truncated');
    if (!Array.isArray(listing.tree)) throw new SkillResolveError('provider_error');

    const dirs = skillDirs(listing.tree.flatMap(toTreeEntry), path);
    const resolved = await Promise.all(dirs.map((dir) => this.readSkill(repoUrl, sha, dir)));

    const names = new Set<string>();
    for (const skill of resolved) {
      if (names.has(skill.name)) throw new SkillResolveError('duplicate_name', skill.name);
      names.add(skill.name);
    }
    return { sha, skills: resolved };
  }

  /** Reads one SKILL.md at the pinned sha. Size is checked from the tree before any contents call. */
  private async readSkill(repoUrl: string, sha: string, dir: string): Promise<ResolvedSkill> {
    const file = obj(await this.getOk(`${repoUrl}/contents/${encodePath(`${dir}/${SKILL_FILE}`)}?ref=${encodeURIComponent(sha)}`));
    if (file.type !== 'file') throw new SkillResolveError('invalid_skill', dir);
    if (typeof file.size !== 'number') throw new SkillResolveError('provider_error');
    if (file.size > MAX_SKILL_BYTES) throw new SkillResolveError('invalid_skill', dir);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new SkillResolveError('provider_error');

    const text = Buffer.from(file.content, 'base64').toString('utf8');
    try {
      return { ...parseSkillFrontmatter(text), dir };
    } catch (error) {
      if (error instanceof SkillResolveError) throw new SkillResolveError('invalid_skill', dir);
      throw error;
    }
  }

  /** GET through FleetHttpClient, mapping its transport failures to the resolver's reasons. */
  private async get(url: string): Promise<{ status: number; body: unknown }> {
    try {
      return await this.http.request('GET', url, HEADERS);
    } catch (error) {
      if (error instanceof RepoCheckException && (error.reason === 'provider_unreachable' || error.reason === 'provider_error')) {
        throw new SkillResolveError(error.reason);
      }
      throw error;
    }
  }

  /** The body of a 200 response. Other statuses map by `overrides` first, then the shared HTTP mapping. */
  private async getOk(url: string, overrides: Partial<Record<number, SkillResolveReason>> = {}): Promise<unknown> {
    const res = await this.get(url);
    if (res.status === 200) return res.body;
    throw new SkillResolveError(overrides[res.status] ?? httpReason(res.status));
  }
}

/**
 * The skill directories directly under `path`: a tree entry whose parent is `path` and that holds a SKILL.md blob.
 * Sorted by dir. Throws no_skills, too_many_skills, or invalid_skill for an oversized SKILL.md.
 */
function skillDirs(entries: TreeEntry[], path: string): string[] {
  const blobSizes = new Map<string, number | null>(
    entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.size]),
  );
  const dirs = entries
    .filter((entry) => entry.type === 'tree' && parentOf(entry.path) === path && blobSizes.has(`${entry.path}/${SKILL_FILE}`))
    .map((entry) => entry.path)
    .sort((a, b) => (a < b ? -1 : 1));

  if (dirs.length === 0) throw new SkillResolveError('no_skills');
  if (dirs.length > MAX_SKILLS) throw new SkillResolveError('too_many_skills');
  for (const dir of dirs) {
    const size = blobSizes.get(`${dir}/${SKILL_FILE}`) ?? null;
    if (size !== null && size > MAX_SKILL_BYTES) throw new SkillResolveError('invalid_skill', dir);
  }
  return dirs;
}

/** Keeps blob and tree entries with a usable path; other entries (submodules) are dropped. */
function toTreeEntry(raw: unknown): TreeEntry[] {
  const entry = obj(raw);
  if ((entry.type !== 'blob' && entry.type !== 'tree') || typeof entry.path !== 'string') return [];
  return [{ path: entry.path, type: entry.type, size: typeof entry.size === 'number' ? entry.size : null }];
}

/** The parent directory of a repo path; '' for a top-level entry. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** URL-encodes each segment of a slash-separated path, keeping the separators. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Reason for a non-200 response that the caller did not map itself. */
function httpReason(status: number): SkillResolveReason {
  if (status === 404) return 'not_public_or_missing';
  if (status === 403 || status === 429) return 'rate_limited';
  return 'provider_error';
}
