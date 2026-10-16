/**
 * Fleet S5b knowledge index US-002 — the search route (1c-c-D12).
 *
 * The route's decision logic is pinned with direct instantiation; a second block drives the real HTTP route
 * (status codes, JSON envelope, the global validation pipe's whitelist) on a Fastify app with the membership
 * guard and the search service stubbed, so both run without a database. The full route against Postgres and
 * the real project membership lives in test/e2e/api-endpoint/endpoint.e2e.spec.ts (AC-9..AC-14).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG } from '../../config/fleet.config';
import type { fleetConfig } from '../../config/fleet.config';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { ProjectContext } from '../../projects/project-context';
import { KnowledgeStoreUnavailableError } from './knowledge-chunk-store';
import { KnowledgeIndexService } from './knowledge-index.service';
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
  index: { resolveProjectRepo: ReturnType<typeof vi.fn> };
  config: { knowledgeIndexEnabled: boolean };
}

function harness(overrides: { enabled?: boolean; result?: KnowledgeSearchResult; repo?: unknown } = {}): Harness {
  const search = { search: vi.fn(async (_input: KnowledgeSearchQuery) => overrides.result ?? RESULT) };
  const index = {
    resolveProjectRepo: vi.fn(async (_projectId: string, _ref: { owner: string; name: string }) =>
      overrides.repo === null ? null : overrides.repo ?? { id: 'repo-1' }),
  };
  const config = { knowledgeIndexEnabled: overrides.enabled ?? true };
  const controller = new ProjectKnowledgeController(
    search as unknown as KnowledgeSearchService,
    index as unknown as KnowledgeIndexService,
    config as unknown as ConfigType<typeof fleetConfig>,
  );
  return { controller, search, index, config };
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
  const config = { knowledgeIndexEnabled: true };

  beforeAll(async () => {
    search = { search: vi.fn(async (_input: KnowledgeSearchQuery) => RESULT) };
    const module = await Test.createTestingModule({
      controllers: [ProjectKnowledgeController],
      providers: [
        { provide: KnowledgeSearchService, useValue: search },
        { provide: KnowledgeIndexService, useValue: { resolveProjectRepo: vi.fn(async () => ({ id: 'repo-1' })) } },
        { provide: FLEET_CFG, useValue: config },
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
});
