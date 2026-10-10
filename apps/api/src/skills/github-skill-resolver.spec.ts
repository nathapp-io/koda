import { FleetHttpClient } from '../fleet/git-broker/fleet-http-client';
import { RepoCheckException } from '../fleet/git-broker/repo-check.exception';
import { GitHubSkillResolver } from './github-skill-resolver';
import { SkillResolveError, SkillResolveReason } from './skill-resolver';

const API = 'https://api.github.test';
const REPO = `${API}/repos/o/r`;
const COMMITS = `${REPO}/commits/release/v1`;
const TREE = `${REPO}/git/trees/abc?recursive=1`;
const INPUT = { owner: 'o', repo: 'r', ref: 'release/v1', path: 'skills' };

type Reply = { status: number; body?: unknown } | Error;
type Table = Map<string, Reply>;

/** Stands in for FleetHttpClient: answers from a URL table and records every request. Unknown URLs fail loudly. */
class StubFleetHttp {
  readonly calls: { method: string; url: string; headers: Record<string, string> }[] = [];

  constructor(private readonly table: Table) {}

  async request(method: 'GET' | 'POST', url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    this.calls.push({ method, url, headers });
    const reply = this.table.get(url);
    if (reply === undefined) throw new Error(`unexpected request: ${url}`);
    if (reply instanceof Error) throw reply;
    return { status: reply.status, body: reply.body };
  }

  urls(): string[] {
    return this.calls.map((call) => call.url);
  }
}

function build(table: Table): { resolver: GitHubSkillResolver; http: StubFleetHttp } {
  const http = new StubFleetHttp(table);
  const resolver = new GitHubSkillResolver({ githubApiUrl: API }, http as unknown as FleetHttpClient);
  return { resolver, http };
}

/** Returns the rejection of `promise`, failing the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function expectReason(promise: Promise<unknown>, reason: SkillResolveReason): Promise<SkillResolveError> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(SkillResolveError);
  expect((error as SkillResolveError).reason).toBe(reason);
  return error as SkillResolveError;
}

const commitOk: Reply = { status: 200, body: { sha: 'abc' } };
const treeOk = (tree: unknown[], truncated = false): Reply => ({ status: 200, body: { sha: 'abc', truncated, tree } });
const dirEntry = (path: string) => ({ path, type: 'tree', sha: 't' });
const blobEntry = (path: string, size = 64) => ({ path, type: 'blob', sha: 'b', size });
const contentsUrl = (dir: string) => `${REPO}/contents/${dir}/SKILL.md?ref=abc`;

function skillText(name: string, description = 'desc'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`;
}

/** A contents API file response carrying `text` as base64, as GitHub returns it. */
function fileReply(text: string): Reply {
  return { status: 200, body: { type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') } };
}

/** The default source: skills/a (valid, name alpha) and skills/b (no SKILL.md), plus a SKILL.md outside path. */
function happyTable(): Table {
  return new Map<string, Reply>([
    [COMMITS, commitOk],
    [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md'), dirEntry('skills/b'), blobEntry('other/c/SKILL.md')])],
    [contentsUrl('skills/a'), fileReply(skillText('alpha', 'First'))],
  ]);
}

describe('GitHubSkillResolver (US-002)', () => {
  it('AC-1: sends GET commits/<ref> as its first request, with the ref path encoded per segment', async () => {
    const { resolver, http } = build(happyTable());

    await resolver.resolve(INPUT);

    expect(http.calls[0]).toMatchObject({ method: 'GET', url: `${REPO}/commits/release/v1` });
  });

  it('AC-2: sends no authorization header on any request', async () => {
    const { resolver, http } = build(happyTable());

    await resolver.resolve(INPUT);

    expect(http.calls).toHaveLength(3);
    for (const call of http.calls) {
      expect(Object.keys(call.headers)).not.toContain('authorization');
      expect(call.headers).toMatchObject({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    }
  });

  it('AC-3: resolves the sha and the skills directly under path, ignoring other directories', async () => {
    const { resolver, http } = build(happyTable());

    const result = await resolver.resolve(INPUT);

    expect(result).toEqual({ sha: 'abc', skills: [{ name: 'alpha', description: 'First', dir: 'skills/a' }] });
    expect(http.urls()).toContain(TREE);
  });

  it('AC-4: fetches a skill directory name with a space as its URL-encoded path segment at the pinned sha', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/my skill'), blobEntry('skills/my skill/SKILL.md')])],
      [`${REPO}/contents/skills/my%20skill/SKILL.md?ref=abc`, fileReply(skillText('my-skill'))],
    ]);
    const { resolver, http } = build(table);

    const result = await resolver.resolve(INPUT);

    expect(http.urls()).toContain(`${REPO}/contents/skills/my%20skill/SKILL.md?ref=abc`);
    expect(result.skills).toEqual([{ name: 'my-skill', description: 'desc', dir: 'skills/my skill' }]);
  });

  it('AC-5: with an empty path, returns the root skill directories sorted by dir', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [
        TREE,
        treeOk([
          dirEntry('b'),
          dirEntry('a'),
          dirEntry('x'),
          dirEntry('x/y'),
          blobEntry('b/SKILL.md'),
          blobEntry('a/SKILL.md'),
          blobEntry('x/y/SKILL.md'),
        ]),
      ],
      [contentsUrl('a'), fileReply(skillText('alpha'))],
      [contentsUrl('b'), fileReply(skillText('bravo'))],
    ]);
    const { resolver } = build(table);

    const result = await resolver.resolve({ ...INPUT, path: '' });

    expect(result.skills.map((skill) => skill.dir)).toEqual(['a', 'b']);
  });

  it('AC-6: maps a 404 from the commits call to not_public_or_missing', async () => {
    const table = new Map<string, Reply>([[COMMITS, { status: 404 }]]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'not_public_or_missing');
  });

  it('AC-7: maps a 422 from the commits call to ref_not_found', async () => {
    const table = new Map<string, Reply>([[COMMITS, { status: 422 }]]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'ref_not_found');
  });

  it('AC-8: maps a 403 from the tree call to rate_limited', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, { status: 403 }],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'rate_limited');
  });

  it('AC-9: maps a truncated tree listing to tree_truncated', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')], true)],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'tree_truncated');
  });

  it('AC-10: rejects a tree with no skill directory under path with no_skills', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/b'), blobEntry('other/c/SKILL.md')])],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'no_skills');
  });

  it('AC-11: rejects a tree with 51 skill directories under path with too_many_skills', async () => {
    const dirs = Array.from({ length: 51 }, (_, i) => `skills/s${i}`);
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk(dirs.flatMap((dir) => [dirEntry(dir), blobEntry(`${dir}/SKILL.md`)]))],
    ]);
    const { resolver, http } = build(table);

    await expectReason(resolver.resolve(INPUT), 'too_many_skills');
    expect(http.urls().some((url) => url.includes('/contents/'))).toBe(false);
  });

  it('AC-11: accepts exactly 50 skill directories under path', async () => {
    const dirs = Array.from({ length: 50 }, (_, i) => `skills/s${i}`);
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk(dirs.flatMap((dir) => [dirEntry(dir), blobEntry(`${dir}/SKILL.md`)]))],
      ...dirs.map((dir): [string, Reply] => [contentsUrl(dir), fileReply(skillText(dir.slice('skills/'.length)))]),
    ]);
    const { resolver } = build(table);

    const result = await resolver.resolve(INPUT);

    expect(result.skills).toHaveLength(50);
  });

  it('AC-12: rejects two skills sharing a name with duplicate_name carrying the name', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md'), dirEntry('skills/b'), blobEntry('skills/b/SKILL.md')])],
      [contentsUrl('skills/a'), fileReply(skillText('dup'))],
      [contentsUrl('skills/b'), fileReply(skillText('dup'))],
    ]);
    const { resolver } = build(table);

    const error = await rejectionOf(resolver.resolve(INPUT));

    expect(error).toEqual(new SkillResolveError('duplicate_name', 'dup'));
    expect(error).toMatchObject({ reason: 'duplicate_name', detail: 'dup' });
  });

  it('AC-13: rejects a SKILL.md over 262144 bytes with invalid_skill naming its dir, before any contents call', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md', 262145)])],
    ]);
    const { resolver, http } = build(table);

    const error = await rejectionOf(resolver.resolve(INPUT));

    expect(error).toEqual(new SkillResolveError('invalid_skill', 'skills/a'));
    expect(error).toMatchObject({ reason: 'invalid_skill', detail: 'skills/a' });
    expect(http.calls).toHaveLength(2);
  });

  it('AC-14: maps a RepoCheckException provider_unreachable from the http client to provider_unreachable', async () => {
    const table = new Map<string, Reply>([[COMMITS, new RepoCheckException('provider_unreachable')]]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'provider_unreachable');
  });

  it('AC-15: maps a 500 from the commits call to provider_error', async () => {
    const table = new Map<string, Reply>([[COMMITS, { status: 500 }]]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'provider_error');
  });

  it('maps a RepoCheckException provider_error from the http client to provider_error', async () => {
    const table = new Map<string, Reply>([[COMMITS, new RepoCheckException('provider_error')]]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'provider_error');
  });

  it('maps a commits body without a sha to provider_error', async () => {
    const table = new Map<string, Reply>([[COMMITS, { status: 200, body: {} }]]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'provider_error');
  });

  it('maps a tree body without a tree array to provider_error', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, { status: 200, body: { sha: 'abc' } }],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'provider_error');
  });

  it('maps a 404 on a contents call to not_public_or_missing', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')])],
      [contentsUrl('skills/a'), { status: 404 }],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'not_public_or_missing');
  });

  it('maps a 429 on a contents call to rate_limited', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')])],
      [contentsUrl('skills/a'), { status: 429 }],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'rate_limited');
  });

  it('rejects a SKILL.md whose frontmatter is invalid with invalid_skill naming its dir', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')])],
      [contentsUrl('skills/a'), fileReply('# no frontmatter\n')],
    ]);
    const { resolver } = build(table);

    const error = await rejectionOf(resolver.resolve(INPUT));

    expect(error).toEqual(new SkillResolveError('invalid_skill', 'skills/a'));
  });

  it('rejects a SKILL.md that is not a regular file (for example a symlink) with invalid_skill naming its dir', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')])],
      [contentsUrl('skills/a'), { status: 200, body: { type: 'symlink' } }],
    ]);
    const { resolver } = build(table);

    const error = await rejectionOf(resolver.resolve(INPUT));

    expect(error).toEqual(new SkillResolveError('invalid_skill', 'skills/a'));
  });

  it('rejects a contents response whose size exceeds 262144 with invalid_skill naming its dir', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')])],
      [contentsUrl('skills/a'), { status: 200, body: { type: 'file', encoding: 'base64', size: 262145, content: '' } }],
    ]);
    const { resolver } = build(table);

    const error = await rejectionOf(resolver.resolve(INPUT));

    expect(error).toEqual(new SkillResolveError('invalid_skill', 'skills/a'));
  });

  it('accepts a SKILL.md of exactly 262144 bytes', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md', 262144)])],
      [contentsUrl('skills/a'), fileReply(skillText('alpha', 'First'))],
    ]);
    const { resolver } = build(table);

    const result = await resolver.resolve(INPUT);

    expect(result.skills).toEqual([{ name: 'alpha', description: 'First', dir: 'skills/a' }]);
  });

  it('maps a contents file response without base64 content to provider_error', async () => {
    const table = new Map<string, Reply>([
      [COMMITS, commitOk],
      [TREE, treeOk([dirEntry('skills/a'), blobEntry('skills/a/SKILL.md')])],
      [contentsUrl('skills/a'), { status: 200, body: { type: 'file', encoding: 'base64', size: 10 } }],
    ]);
    const { resolver } = build(table);

    await expectReason(resolver.resolve(INPUT), 'provider_error');
  });
});
