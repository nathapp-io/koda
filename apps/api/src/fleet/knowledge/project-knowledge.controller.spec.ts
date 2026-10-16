/**
 * Fleet S5b knowledge index US-002 — the search route (1c-c-D12).
 *
 * The route's decision logic is pinned with direct instantiation; a second block drives the real HTTP route
 * (status codes, JSON envelope, the global validation pipe's whitelist) on a Fastify app with the membership
 * guard stubbed, and a third drives it with the real `ProjectMembershipGuard` over a stubbed
 * `ProjectAccessService`, so a non-member's refusal is pinned without a database. The full route against
 * Postgres and the real project membership lives in test/e2e/api-endpoint/endpoint.e2e.spec.ts (AC-9..AC-14).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG } from '../../config/fleet.config';
import type { fleetConfig } from '../../config/fleet.config';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { ProjectAccessService } from '../../projects/project-access.service';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { ProjectContext } from '../../projects/project-context';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeStoreUnavailableError } from './knowledge-chunk-store';
import type { KnowledgeIndexState, KnowledgeProjectState, KnowledgeRepoRef } from './knowledge-index.domain';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeIndexQueue } from './knowledge-index.queue';
import type { KnowledgeRepoStatesDto } from './knowledge-repo-state.dto';
import type { KnowledgeHit, KnowledgeSearchQuery, KnowledgeSearchResult } from './knowledge-search.service';
import { KnowledgeSearchService } from './knowledge-search.service';
import { KnowledgeSearchBodyDto, ProjectKnowledgeController } from './project-knowledge.controller';

const PROJECT_ID = 'proj-1';
const PROJECT: ProjectContext = { project: { id: PROJECT_ID, slug: 'koda' }, role: 'DEVELOPER' };

const HIT: KnowledgeHit = {
  repoId: 'repo-1', owner: 'o', name: 'n', path: 'docs/adr/1.md', sha: 'sha-1', anchor: 'adr',
  headingPath: 'ADR', title: 'ADR 1', abstract: 'abstract', snippet: 'snippet', score: 1 / 61,
};
const RESULT: KnowledgeSearchResult = { lexicalOnly: false, empty: false, hits: [HIT] };

interface Harness {
  controller: ProjectKnowledgeController;
  search: { search: ReturnType<typeof vi.fn> };
  index: { resolveProjectRepo: ReturnType<typeof vi.fn>; listProjectStates: ReturnType<typeof vi.fn> };
  queue: { enqueue: ReturnType<typeof vi.fn> };
  config: { knowledgeIndexEnabled: boolean };
}

function harness(overrides: {
  enabled?: boolean;
  result?: KnowledgeSearchResult;
  repo?: unknown;
  states?: KnowledgeProjectState[];
} = {}): Harness {
  const search = { search: vi.fn(async (_input: KnowledgeSearchQuery) => overrides.result ?? RESULT) };
  const index = {
    resolveProjectRepo: vi.fn(async (_projectId: string, _ref: { owner: string; name: string }) =>
      overrides.repo === null ? null : overrides.repo ?? { id: 'repo-1' }),
    listProjectStates: vi.fn(async (_projectId: string) => overrides.states ?? []),
  };
  const queue = { enqueue: vi.fn() };
  const config = { knowledgeIndexEnabled: overrides.enabled ?? true };
  const controller = new ProjectKnowledgeController(
    search as unknown as KnowledgeSearchService,
    index as unknown as KnowledgeIndexService,
    config as unknown as ConfigType<typeof fleetConfig>,
    queue as unknown as KnowledgeIndexQueue,
  );
  return { controller, search, index, queue, config };
}

/** The error a call throws, so a test can assert on the exception the route would map to a status. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('ProjectKnowledgeController.search', () => {
  it('AC-9: resolves owner/name to the project repository and answers the service result', async () => {
    const { controller, search, index } = harness();

    const response = await controller.search({ query: 'broker', repo: 'o/n', limit: 5 }, PROJECT);

    expect(index.resolveProjectRepo).toHaveBeenCalledWith(PROJECT_ID, { owner: 'o', name: 'n' });
    expect(search.search).toHaveBeenCalledWith({ projectId: PROJECT_ID, query: 'broker', repoId: 'repo-1', limit: 5 });
    expect(response).toEqual({ ret: 0, data: RESULT });
  });

  it('searches the whole project when the body carries no repo and defaults the limit', async () => {
    const { controller, search, index } = harness();

    const response = await controller.search({ query: 'broker' }, PROJECT);

    expect(index.resolveProjectRepo).not.toHaveBeenCalled();
    expect(search.search).toHaveBeenCalledWith({ projectId: PROJECT_ID, query: 'broker', limit: 20 });
    expect(response).toEqual({ ret: 0, data: RESULT });
  });

  it('passes the path prefix through to the search', async () => {
    const { controller, search } = harness();

    await controller.search({ query: 'broker', pathPrefix: 'docs/adr/' }, PROJECT);

    expect(search.search).toHaveBeenCalledWith({ projectId: PROJECT_ID, query: 'broker', pathPrefix: 'docs/adr/', limit: 20 });
  });

  it('AC-10: answers 400 and never searches for a rejected body', async () => {
    const { controller, search, index } = harness();

    const error = await rejectionOf(() => controller.search({ query: '' }, PROJECT));

    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).getStatus()).toBe(400);
    expect((error as ValidationAppException).prefix).toBe('knowledge.input');
    expect(search.search).not.toHaveBeenCalled();
    expect(index.resolveProjectRepo).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty query', { query: '' }],
    ['a traversing pathPrefix', { query: 'q', pathPrefix: '../x' }],
    ['a leading slash pathPrefix', { query: 'q', pathPrefix: '/docs' }],
    ['a repo outside owner/name', { query: 'q', repo: 'n' }],
    ['limit 0', { query: 'q', limit: 0 }],
    ['limit 51', { query: 'q', limit: 51 }],
    ['a missing query', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const { controller } = harness();

    const error = await rejectionOf(() => controller.search(body as KnowledgeSearchBodyDto, PROJECT));

    expect(error).toBeInstanceOf(ValidationAppException);
  });

  it('AC-11: answers 404 for a repository the project does not own', async () => {
    const { controller, search } = harness({ repo: null });

    const error = await rejectionOf(() => controller.search({ query: 'broker', repo: 'o/missing' }, PROJECT));

    expect(error).toBeInstanceOf(NotFoundAppException);
    expect((error as NotFoundAppException).getStatus()).toBe(404);
    expect((error as NotFoundAppException).prefix).toBe('knowledge.repoNotFound');
    expect(search.search).not.toHaveBeenCalled();
  });

  it('AC-12: answers 409 while the kill switch is off and never searches', async () => {
    const { controller, search, index } = harness({ enabled: false });

    const error = await rejectionOf(() => controller.search({ query: 'broker', repo: 'o/n' }, PROJECT));

    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).getStatus()).toBe(409);
    expect((error as ConflictAppException).prefix).toBe('knowledge.disabled');
    expect(search.search).not.toHaveBeenCalled();
    expect(index.resolveProjectRepo).not.toHaveBeenCalled();
  });

  it('AC-13: answers 409 knowledge.unavailable when the store is down and searches once', async () => {
    const { controller, search } = harness();
    search.search.mockRejectedValue(new KnowledgeStoreUnavailableError());

    const error = await rejectionOf(() => controller.search({ query: 'broker' }, PROJECT));

    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).getStatus()).toBe(409);
    expect((error as ConflictAppException).prefix).toBe('knowledge.unavailable');
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it('lets an unexpected search failure through instead of reporting it as an outage', async () => {
    const { controller, search } = harness();
    search.search.mockRejectedValue(new Error('index corrupt'));

    const error = await rejectionOf(() => controller.search({ query: 'broker' }, PROJECT));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConflictAppException);
    expect((error as Error).message).toBe('index corrupt');
  });
});

const REPO: KnowledgeRepoRef = {
  id: 'repo-1', projectId: PROJECT_ID, provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
  githubInstallationId: BigInt(7),
};
const GITLAB_REPO: KnowledgeRepoRef = { ...REPO, id: 'repo-2', provider: 'gitlab', owner: 'grp', name: 'lib', githubInstallationId: null };
const INDEX_STATE: KnowledgeIndexState = {
  repoId: 'repo-1', projectId: PROJECT_ID, status: 'idle', indexedSha: 'sha-1', fileCount: 2, chunkCount: 5,
  unembeddedCount: 1, skippedCount: 3, lastError: null, leaseUntil: null,
  startedAt: new Date('2026-10-15T10:00:00.000Z'), finishedAt: new Date('2026-10-15T10:01:00.000Z'),
  updatedAt: new Date('2026-10-15T10:01:00.000Z'),
};

describe('ProjectKnowledgeController repos (US-005, 1c-c-D12)', () => {
  it('AC-14: answers one entry per project repository with `never` for a repository that has no state row', async () => {
    const { controller, index } = harness({ states: [{ repo: REPO, state: INDEX_STATE }, { repo: GITLAB_REPO, state: null }] });

    const response = await controller.repos(PROJECT);

    expect(index.listProjectStates).toHaveBeenCalledWith(PROJECT_ID);
    expect(response).toEqual({
      ret: 0,
      data: {
        enabled: true,
        repos: [
          {
            repoId: 'repo-1', owner: 'o', name: 'n', provider: 'github', status: 'idle', indexedSha: 'sha-1',
            fileCount: 2, chunkCount: 5, unembeddedCount: 1, skippedCount: 3, lastError: null,
            startedAt: INDEX_STATE.startedAt, finishedAt: INDEX_STATE.finishedAt,
          },
          {
            repoId: 'repo-2', owner: 'grp', name: 'lib', provider: 'gitlab', status: 'never', indexedSha: null,
            fileCount: 0, chunkCount: 0, unembeddedCount: 0, skippedCount: 0, lastError: null,
            startedAt: null, finishedAt: null,
          },
        ],
      },
    });
  });

  it('AC-14: reports enabled false while the kill switch is off and still lists the repositories', async () => {
    const { controller } = harness({ enabled: false, states: [{ repo: REPO, state: null }] });

    const response = await controller.repos(PROJECT);

    expect(response.data).toMatchObject({ enabled: false, repos: [{ repoId: 'repo-1', status: 'never' }] });
  });

  it('answers an empty list for a project with no fleet repository', async () => {
    const { controller } = harness();

    await expect(controller.repos(PROJECT)).resolves.toEqual({ ret: 0, data: { enabled: true, repos: [] } });
  });

  it('carries a failed pass through as its status, reason and finish time', async () => {
    const failed: KnowledgeIndexState = { ...INDEX_STATE, status: 'failed', indexedSha: null, lastError: 'tree truncated', startedAt: null };
    const { controller } = harness({ states: [{ repo: REPO, state: failed }] });

    const response = await controller.repos(PROJECT);
    const data = response.data as KnowledgeRepoStatesDto;

    expect(data.repos[0]).toMatchObject({ status: 'failed', lastError: 'tree truncated', indexedSha: null, startedAt: null });
  });
});

describe('ProjectKnowledgeController reindex (US-005, 1c-c-D12)', () => {
  it('AC-11: queues an admin pass for one of the project repositories', async () => {
    const { controller, queue, index } = harness();

    const response = await controller.reindex('repo-1', PROJECT);

    expect(index.resolveProjectRepo).toHaveBeenCalledWith(PROJECT_ID, { repoId: 'repo-1' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith('repo-1', 'admin');
    expect(response).toEqual({ ret: 0, data: { queued: true } });
  });

  it('AC-12: answers 404 for a repository the project does not own and queues nothing', async () => {
    const { controller, queue } = harness({ repo: null });

    const error = await rejectionOf(() => controller.reindex('foreign', PROJECT));

    expect(error).toBeInstanceOf(NotFoundAppException);
    expect((error as NotFoundAppException).getStatus()).toBe(404);
    expect((error as NotFoundAppException).prefix).toBe('knowledge.repoNotFound');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('AC-13: answers 409 while the kill switch is off and queues nothing', async () => {
    const { controller, queue, index } = harness({ enabled: false });

    const error = await rejectionOf(() => controller.reindex('repo-1', PROJECT));

    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).getStatus()).toBe(409);
    expect((error as ConflictAppException).prefix).toBe('knowledge.disabled');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(index.resolveProjectRepo).not.toHaveBeenCalled();
  });

  it('AC-11/AC-12: reindex is a global ADMIN route, so a developer is refused by the permission guard', () => {
    const permissions = Reflect.getMetadata(PERMISSION_KEY, ProjectKnowledgeController.prototype.reindex) as unknown;
    expect(JSON.stringify(permissions)).toContain('ADMIN');
    // The member-facing reads carry a membership guard, not an admin permission.
    expect(Reflect.getMetadata(PERMISSION_KEY, ProjectKnowledgeController.prototype.repos)).toBeUndefined();
  });
});

/**
 * The route as HTTP: the same app-level pipe the API boots with (whitelist, so a body whose fields are not
 * marked with `@Allow()` arrives empty by default) and the JSON envelope. The membership guard is replaced by
 * one that attaches the project context, so no Postgres is needed; the guard itself is pinned by the endpoint
 * e2e suite (AC-14). Requests go through Fastify's `inject`, which needs no listening socket.
 */
describe('POST /projects/:slug/knowledge/search', () => {
  let app: INestApplication;
  let fastify: { inject: (options: Record<string, unknown>) => Promise<{ statusCode: number; json: () => unknown }> };
  let search: { search: ReturnType<typeof vi.fn> };
  let index: { resolveProjectRepo: ReturnType<typeof vi.fn>; listProjectStates: ReturnType<typeof vi.fn> };
  let queue: { enqueue: ReturnType<typeof vi.fn> };
  const config = { knowledgeIndexEnabled: true };

  beforeAll(async () => {
    search = { search: vi.fn(async (_input: KnowledgeSearchQuery) => RESULT) };
    index = {
      resolveProjectRepo: vi.fn(async () => ({ id: 'repo-1' })),
      listProjectStates: vi.fn(async () => [{ repo: REPO, state: INDEX_STATE }, { repo: GITLAB_REPO, state: null }]),
    };
    queue = { enqueue: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [ProjectKnowledgeController],
      providers: [
        { provide: KnowledgeSearchService, useValue: search },
        { provide: KnowledgeIndexService, useValue: index },
        { provide: FLEET_CFG, useValue: config },
        { provide: KnowledgeIndexQueue, useValue: queue },
      ],
    })
      .overrideGuard(ProjectMembershipGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }): boolean => {
          ctx.switchToHttp().getRequest().projectContext = PROJECT;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ forbidUnknownValues: false, stopAtFirstError: true, whitelist: true }));
    await app.init();
    fastify = app.getHttpAdapter().getInstance() as typeof fastify;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    search.search.mockReset();
    search.search.mockResolvedValue(RESULT);
    index.resolveProjectRepo.mockReset();
    index.resolveProjectRepo.mockResolvedValue({ id: 'repo-1' });
    queue.enqueue.mockClear();
    config.knowledgeIndexEnabled = true;
  });

  const post = (payload: unknown): Promise<{ statusCode: number; json: () => unknown }> => fastify.inject({
    method: 'POST',
    url: '/api/projects/koda/knowledge/search',
    headers: { authorization: 'Bearer test-token' },
    payload,
  });

  it('AC-9: answers 200 with the { lexicalOnly, empty, hits } envelope', async () => {
    const res = await post({ query: 'broker', repo: 'o/n', limit: 5 });

    expect(res.statusCode).toBe(200);
    expect(search.search).toHaveBeenCalledWith({ projectId: PROJECT_ID, query: 'broker', repoId: 'repo-1', limit: 5 });
    expect(res.json()).toEqual({ ret: 0, data: RESULT });
  });

  it('answers 200 and searches the whole project for a body without repo or limit', async () => {
    const res = await post({ query: 'broker' });

    expect(res.statusCode).toBe(200);
    expect(search.search).toHaveBeenCalledWith({ projectId: PROJECT_ID, query: 'broker', limit: 20 });
  });

  it('AC-10: answers 400 for an empty query, a traversing pathPrefix and a missing body', async () => {
    for (const payload of [{ query: '' }, { query: 'broker', pathPrefix: '../x' }, {}, { query: 'x'.repeat(501) }]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(search.search).not.toHaveBeenCalled();
  });

  it('AC-11: answers 404 for a repository outside the project', async () => {
    const index = app.get(KnowledgeIndexService) as unknown as { resolveProjectRepo: () => Promise<unknown> };
    const resolve = vi.spyOn(index, 'resolveProjectRepo').mockResolvedValueOnce(null);
    try {
      const res = await post({ query: 'broker', repo: 'o/missing' });

      expect(res.statusCode).toBe(404);
      expect(search.search).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
  });

  it('AC-12: answers 409 and does not search while the kill switch is off', async () => {
    config.knowledgeIndexEnabled = false;

    const res = await post({ query: 'broker' });

    expect(res.statusCode).toBe(409);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('AC-13: answers 409 when the store is unavailable', async () => {
    search.search.mockRejectedValue(new KnowledgeStoreUnavailableError());

    const res = await post({ query: 'broker' });

    expect(res.statusCode).toBe(409);
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it('answers 409 for an invalid body while the kill switch is off, because the switch is checked first', async () => {
    config.knowledgeIndexEnabled = false;

    const res = await post({ query: '' });

    expect(res.statusCode).toBe(409);
  });

  // ── US-005: the state and reindex routes over the same app ────────────────────────────────────────────
  const get = (): Promise<{ statusCode: number; json: () => unknown }> => fastify.inject({
    method: 'GET',
    url: '/api/projects/koda/knowledge/repos',
    headers: { authorization: 'Bearer test-token' },
  });

  const reindex = (repoId: string): Promise<{ statusCode: number; json: () => unknown }> => fastify.inject({
    method: 'POST',
    url: `/api/projects/koda/knowledge/repos/${repoId}/reindex`,
    headers: { authorization: 'Bearer test-token' },
  });

  it('AC-14: GET repos answers 200 with the enabled flag and the repository states', async () => {
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(index.listProjectStates).toHaveBeenCalledWith(PROJECT_ID);
    expect(res.json()).toEqual({
      ret: 0,
      data: {
        enabled: true,
        repos: [
          expect.objectContaining({ repoId: 'repo-1', status: 'idle', fileCount: 2, finishedAt: '2026-10-15T10:01:00.000Z' }),
          expect.objectContaining({ repoId: 'repo-2', provider: 'gitlab', status: 'never', indexedSha: null, startedAt: null }),
        ],
      },
    });
  });

  it('AC-14: GET repos answers enabled false while the kill switch is off', async () => {
    config.knowledgeIndexEnabled = false;

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { enabled: false } });
  });

  it('AC-11: POST reindex answers 202 { queued: true } and queues the admin pass', async () => {
    const res = await reindex('repo-1');

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ret: 0, data: { queued: true } });
    expect(queue.enqueue).toHaveBeenCalledWith('repo-1', 'admin');
  });

  it('AC-12: POST reindex answers 404 for a repository outside the project', async () => {
    index.resolveProjectRepo.mockResolvedValueOnce(null);

    const res = await reindex('foreign');

    expect(res.statusCode).toBe(404);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('AC-13: POST reindex answers 409 while the kill switch is off', async () => {
    config.knowledgeIndexEnabled = false;

    const res = await reindex('repo-1');

    expect(res.statusCode).toBe(409);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * AC-14's refusal, runnable without a database: the real `ProjectMembershipGuard` is attached to the route, and
 * its `ProjectAccessService` is replaced with one that resolves the project and refuses the caller the way a
 * non-member (`resolveMembership`) does. An authenticating global guard supplies the principal the membership
 * guard reads, so the 403 below comes from the membership and not from a missing principal.
 */
describe('POST /projects/:slug/knowledge/search without project membership', () => {
  let app: INestApplication;
  let fastify: { inject: (options: Record<string, unknown>) => Promise<{ statusCode: number; json: () => unknown }> };
  let search: { search: ReturnType<typeof vi.fn> };
  let membership: 'member' | 'non-member';

  beforeAll(async () => {
    search = { search: vi.fn(async () => RESULT) };
    const access = {
      findProjectIdBySlug: vi.fn(async () => PROJECT_ID),
      resolveMembership: vi.fn(async () => {
        if (membership === 'non-member') throw new ForbiddenAppException({}, 'projects');
        return 'DEVELOPER';
      }),
    };
    const principal = { kind: 'user', id: 'user-1', role: 'MEMBER' };
    const module = await Test.createTestingModule({
      imports: [GlobalStubsModule, ProjectAccessModule],
      controllers: [ProjectKnowledgeController],
      providers: [
        { provide: KnowledgeSearchService, useValue: search },
        { provide: KnowledgeIndexService, useValue: { resolveProjectRepo: vi.fn(async () => ({ id: 'repo-1' })), listProjectStates: vi.fn(async () => []) } },
        { provide: FLEET_CFG, useValue: { knowledgeIndexEnabled: true } },
        { provide: KnowledgeIndexQueue, useValue: { enqueue: vi.fn() } },
        // The API authenticates with CombinedAuthGuard before ProjectMembershipGuard; without a principal every
        // request is refused for the wrong reason (`!req.user`), so the member case would prove nothing.
        { provide: APP_GUARD, useValue: {
          canActivate: (ctx: ExecutionContext): boolean => {
            ctx.switchToHttp().getRequest().user = principal;
            return true;
          },
        } },
      ],
    })
      .overrideProvider(ProjectAccessService)
      .useValue(access)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    fastify = app.getHttpAdapter().getInstance() as typeof fastify;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    membership = 'member';
    search.search.mockClear();
  });

  const post = (): Promise<{ statusCode: number; json: () => unknown }> => fastify.inject({
    method: 'POST',
    url: '/api/projects/koda/knowledge/search',
    headers: { authorization: 'Bearer test-token' },
    payload: { query: 'broker' },
  });

  it('AC-14: answers 403 and does not search for a non-member', async () => {
    membership = 'non-member';

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('searches for a project member, so the refusal above is the membership, not the route', async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(search.search).toHaveBeenCalledTimes(1);
  });
});
