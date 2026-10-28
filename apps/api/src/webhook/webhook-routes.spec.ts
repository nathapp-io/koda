import { ApprovalRouteGate, type RouteGateCall } from '../approvals/route/approval-route-gate';
/**
 * US-003 — webhook create/update over a real HTTP pipeline (Fastify, in-process).
 *
 * The controller, `WebhookService`, `PrismaWebhookRepository` and the production
 * `OutboundUrlGuard` are all real. Only the database is fake (`PrismaService.client` is an
 * in-memory webhook/project store — the same seam `src/agents/agents-create.routes.spec.ts`
 * uses) and the DNS seam is stubbed, so nothing here opens a socket: requests go through
 * Fastify's in-process `inject()`.
 *
 * The actual `ProjectMembershipGuard` and `RequiresGuard` run on the route methods. ProjectAccessService
 * and PermissionService are test doubles: the former resolves fixture project access, and the latter
 * grants the designated admin and viewer read key while refusing other keys/principals. The principal
 * injector stands in for the global CombinedAuthGuard.
 *
 * ACs covered here:
 *  AC9  POST with a blocked destination -> 400, no webhook row for the project
 *  AC10 POST with an allowed destination -> 201
 *  AC11 PATCH with an http:// url -> 400, the stored url is unchanged
 *  AC12 PATCH { active: false } -> 200, data.active false, no data.secret
 *  AC13 PATCH without webhook.update -> 403
 *  AC14 PATCH of a webhook owned by another project -> 404, that webhook is untouched
 *  AC16 POST/PATCH with an unresolvable hostname -> 400, nothing written
 *
 * `test/integration/webhook/webhook-routes.integration.spec.ts` repeats AC9-AC14 against
 * a real Postgres database and the real JWT/registration auth chain.
 */
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import {
  CommonExceptionCode,
  ForbiddenAppException,
  GlobalExceptionsFilter,
  I18nCoreModule,
  I18nWrapper,
} from '@nathapp/nestjs-common';
import { PermissionService } from '../permissions/permission.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { ProjectAccessService } from '../projects/project-access.service';
import { join } from 'node:path';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { DnsResolver } from './outbound/dns-resolver';
import { OutboundUrlGuard } from './outbound/outbound-url-guard';
import { WEBHOOK_CFG, IWebhookConfig } from '../config/webhook.config';
import { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { AuditRecorder } from '../audit/audit-recorder.service';

const webhookKeys = ['webhook.read', 'webhook.create', 'webhook.update', 'webhook.delete'];
const permissions: Pick<PermissionService, 'can'> = {
  can: vi.fn<PermissionService['can']>(async (principal, key, context = {}) => {
    const allowed = webhookKeys.includes(key) && principal.actorType === 'user' && (
      principal.id === adminPrincipal.id ||
      (principal.id === projectAdminPrincipal.id && context.projectId !== undefined) ||
      (principal.id === viewerPrincipal.id && key === 'webhook.read')
    );
    return { allowed, reason: allowed ? 'granted' : 'not-granted' };
  }),
};

interface WebhookRow {
  id: string;
  projectId: string;
  url: string;
  secret: string;
  events: string;
  active: boolean;
  createdAt: Date;
}

interface ProjectRow {
  id: string;
  slug: string;
  deletedAt: Date | null;
}

interface FakeStore {
  projects: ProjectRow[];
  webhooks: WebhookRow[];
}

/** The JsonResponse envelope: `{ ret: 0, data }` on success, `{ ret, message }` on error. */
interface ApiResponse {
  status: number;
  body: {
    ret?: number;
    message?: string;
    data: Record<string, unknown>;
  };
}

const projectA: ProjectRow = { id: 'proj-a', slug: 'alpha', deletedAt: null };
const projectB: ProjectRow = { id: 'proj-b', slug: 'beta', deletedAt: null };

const store: FakeStore = { projects: [projectA, projectB], webhooks: [] };

/**
 * The webhook/project columns `PrismaWebhookRepository` reads. `webhook.create` mirrors the
 * schema default `active = true`; `webhook.update` mirrors `toPersistenceUpdate`, which only
 * writes the fields it was given.
 */
function makeFakeClient(target: FakeStore): Record<string, unknown> {
  let sequence = 0;

  return {
    project: {
      findUnique: async ({ where }: { where: { slug: string } }) =>
        target.projects.find((project) => project.slug === where.slug) ?? null,
    },
    webhook: {
      create: async ({
        data,
      }: {
        data: { projectId: string; url: string; secret: string; events: string };
      }) => {
        const row: WebhookRow = {
          id: `wh-${++sequence}`,
          projectId: data.projectId,
          url: data.url,
          secret: data.secret,
          events: data.events,
          active: true,
          createdAt: new Date(),
        };
        target.webhooks.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        target.webhooks.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where, select }: {
        where?: { projectId?: string; active?: boolean };
        select?: Partial<Record<keyof WebhookRow, boolean>>;
      } = {}) => target.webhooks
        .filter((row) => (where?.projectId === undefined || row.projectId === where.projectId)
          && (where?.active === undefined || row.active === where.active))
        .map((row) => select
          ? Object.fromEntries(Object.entries(row).filter(([key]) => select[key as keyof WebhookRow]))
          : { ...row }),
      update: async ({ where, data }: { where: { id: string }; data: Partial<WebhookRow> }) => {
        const row = target.webhooks.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error(`webhook ${where.id} does not exist`);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const index = target.webhooks.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error(`webhook ${where.id} does not exist`);
        const [row] = target.webhooks.splice(index, 1);
        return row;
      },
    },
  };
}

const fakeClient = makeFakeClient(store);

const webhookConfig: IWebhookConfig = {
  allowedHostnames: [],
  allowedCidrs: [],
  deliveryTimeoutMs: 5000,
};

/** US-002 failure mode: the hostname does not resolve, and no real lookup is performed. */
function makeUnresolvableResolver(): DnsResolver {
  return {
    resolve: async (hostname: string): Promise<string[]> => {
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    },
  };
}

const adminPrincipal: UserPrincipal = {
  actorType: 'user',
  id: 'user-admin',
  name: 'admin@koda.dev',
  email: 'admin@koda.dev',
  role: 'ADMIN',
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
  extra: {},
};

const memberPrincipal: UserPrincipal = {
  ...adminPrincipal,
  id: 'user-member',
  name: 'member@koda.dev',
  email: 'member@koda.dev',
  role: 'MEMBER',
  authorities: ['MEMBER'],
};

const viewerPrincipal: UserPrincipal = {
  ...memberPrincipal,
  id: 'user-viewer',
  name: 'viewer@koda.dev',
  email: 'viewer@koda.dev',
};

const projectAdminPrincipal: UserPrincipal = {
  ...memberPrincipal,
  id: 'user-project-admin',
  name: 'project-admin@koda.dev',
  email: 'project-admin@koda.dev',
};

const outsiderPrincipal: UserPrincipal = {
  ...memberPrincipal,
  id: 'user-outsider',
  name: 'outsider@koda.dev',
  email: 'outsider@koda.dev',
};

/** Seeds a webhook row directly, the way a row created before US-003 would already exist. */
function seedWebhook(projectId: string, url: string): WebhookRow {
  const row: WebhookRow = {
    id: `wh-seed-${store.webhooks.length + 1}`,
    projectId,
    url,
    secret: 'seed-secret',
    events: '["STATUS_CHANGE"]',
    active: true,
    createdAt: new Date(),
  };
  store.webhooks.push(row);
  return row;
}

function rowOf(id: string): WebhookRow | undefined {
  return store.webhooks.find((row) => row.id === id);
}

describe('webhook routes (US-003)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;
  let currentPrincipal: KodaPrincipal;

  /** Drives one request through the real pipeline (pipes, guards, filters) in-process. */
  async function callApi(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<ApiResponse> {
    const res = await app.inject({ method, url, payload });
    const parsed = (res.statusCode === 204 ? {} : res.json()) as {
      ret?: number;
      message?: string;
      data?: Record<string, unknown>;
    };
    return {
      status: res.statusCode,
      body: { ret: parsed.ret, message: parsed.message, data: parsed.data ?? {} },
    };
  }

  beforeAll(async () => {
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => fakeClient as unknown as C,
      isInTransaction: () => false,
    };

    testingModule = await Test.createTestingModule({
      imports: [
        I18nCoreModule.forRoot({
          fallbackLanguage: 'en',
          loaderOptions: { path: join(__dirname, '../i18n'), watch: false },
        }),
      ],
      controllers: [WebhookController],
      providers: [
        WebhookService,
        {
          provide: ApprovalRouteGate,
          inject: [WebhookService],
          useFactory: (service: WebhookService) => ({
            run: async ({ variant, input }: RouteGateCall) => {
              const ids = input as { projectId: string; id: string };
              if (variant === 'rest:project-webhooks.delete') await service.removeForProject(ids.projectId, ids.id);
              else if (variant === 'rest:webhooks.delete') await service.remove(ids.id);
              else throw new Error('Unexpected webhook command');
              return { status: 'executed', result: null };
            },
          }),
        },
        { provide: AuditRecorder, useValue: { audited: async (fn: () => Promise<unknown>) => fn(), record: vi.fn() } },
        PrismaWebhookRepository,
        OutboundUrlGuard,
        { provide: PrismaService, useValue: { client: fakeClient } },
        { provide: TRANSACTION_MANAGER, useValue: txManager },
        { provide: WEBHOOK_CFG, useValue: webhookConfig },
        { provide: DnsResolver, useValue: makeUnresolvableResolver() },
        ProjectMembershipGuard,
        {
          provide: ProjectAccessService,
          useValue: {
            findProjectIdBySlug: async (slug: string) => {
              const project = [projectA, projectB].find((row) => row.slug === slug);
              return project?.id ?? 'missing';
            },
            resolveMembership: async (_projectId: string, principal: KodaPrincipal) => {
              if (principal.actorType === 'user' && principal.id === outsiderPrincipal.id) {
                throw new ForbiddenAppException({}, 'projects');
              }
              return 'MEMBER';
            },
          },
        },
        { provide: PermissionService, useValue: permissions },
        RequiresGuard,
      ],
    }).compile();

    app = testingModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalFilters(
      new GlobalExceptionsFilter(
        testingModule.get(HttpAdapterHost),
        testingModule.get(I18nWrapper).I18nService,
      ),
    );

    // Stands in for the global CombinedAuthGuard: it puts the principal on the request that
    // route guards read.
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = currentPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.mocked(permissions.can).mockClear();
    store.webhooks.length = 0;
    currentPrincipal = adminPrincipal;
  });

  it.each([
    ['POST', '/api/projects/alpha/webhooks', 'webhook.create', projectA.id],
    ['GET', '/api/projects/alpha/webhooks', 'webhook.read', projectA.id],
    ['PATCH', '/api/projects/alpha/webhooks/wh-seed-1', 'webhook.update', projectA.id],
    ['DELETE', '/api/projects/alpha/webhooks/wh-seed-1', 'webhook.delete', projectA.id],
    ['DELETE', '/api/webhooks/wh-seed-1', 'webhook.delete', undefined],
  ] as const)('%s %s checks %s in the resolved scope', async (method, url, key, projectId) => {
    await callApi(method, url);
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(adminPrincipal, key, { projectId });
  });

  it('delivery reads retain secrets and exclude inactive webhooks', async () => {
    const active = seedWebhook(projectA.id, 'https://93.184.215.14/hook');
    seedWebhook(projectA.id, 'https://93.184.215.14/inactive').active = false;
    seedWebhook(projectB.id, 'https://93.184.215.14/other');

    const rows = await testingModule.get(PrismaWebhookRepository).findActiveByProject(projectA.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: active.id, secret: active.secret });
  });

  it('AC-3: a viewer lists project webhooks without secret fields', async () => {
    seedWebhook(projectA.id, 'https://93.184.215.14/hook');
    currentPrincipal = viewerPrincipal;

    const res = await callApi('GET', '/api/projects/alpha/webhooks');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty('secret');
  });

  it('AC-6: a project-admin deletes its project webhook', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');
    currentPrincipal = projectAdminPrincipal;

    const res = await callApi('DELETE', `/api/projects/alpha/webhooks/${webhook.id}`);

    expect(res.status).toBe(204);
    expect(rowOf(webhook.id)).toBeUndefined();
  });

  it('AC-7: a developer cannot delete its project webhook', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');
    currentPrincipal = memberPrincipal;

    const res = await callApi('DELETE', `/api/projects/alpha/webhooks/${webhook.id}`);

    expect(res.status).toBe(403);
    expect(rowOf(webhook.id)).toBeDefined();
  });

  it('AC-8: a project-admin cannot use global webhook deletion', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');
    currentPrincipal = projectAdminPrincipal;

    const res = await callApi('DELETE', `/api/webhooks/${webhook.id}`);

    expect(res.status).toBe(403);
    expect(rowOf(webhook.id)).toBeDefined();
  });

  it('AC-9: a global admin can delete a webhook through the global route', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('DELETE', `/api/webhooks/${webhook.id}`);

    expect(res.status).toBe(204);
    expect(rowOf(webhook.id)).toBeUndefined();
  });

  it('AC-10: a principal with no project access is refused before permission evaluation', async () => {
    currentPrincipal = outsiderPrincipal;

    const res = await callApi('GET', '/api/projects/alpha/webhooks');

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(testingModule.get(I18nWrapper).I18nService.t('projects.40003', { lang: 'en' }));
  });

  it('AC9: POST with the blocked destination https://10.0.0.5/hook returns 400 and leaves no webhook row', async () => {
    const res = await callApi('POST', '/api/projects/alpha/webhooks', {
      url: 'https://10.0.0.5/hook',
      events: ['STATUS_CHANGE'],
    });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CommonExceptionCode.REQUEST_PARAMETER_ERROR);
    expect(store.webhooks.filter((row) => row.projectId === projectA.id)).toHaveLength(0);
  });

  it('AC9 boundary: the rejection names the blocked destination', async () => {
    const res = await callApi('POST', '/api/projects/alpha/webhooks', {
      url: 'https://10.0.0.5/hook',
      events: ['STATUS_CHANGE'],
    });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('blocked_destination');
  });

  it('AC10: POST with the allowed destination https://93.184.215.14/hook returns 201', async () => {
    const res = await callApi('POST', '/api/projects/alpha/webhooks', {
      url: 'https://93.184.215.14/hook',
      events: ['STATUS_CHANGE'],
    });

    expect(res.status).toBe(201);
    expect(res.body.data['url']).toBe('https://93.184.215.14/hook');
    expect(store.webhooks.filter((row) => row.projectId === projectA.id)).toHaveLength(1);
  });

  it('AC11: PATCH with the http:// url returns 400 and leaves the stored url unchanged', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, {
      url: 'http://93.184.215.14/hook',
    });

    expect(res.status).toBe(400);
    expect(rowOf(webhook.id)?.url).toBe('https://93.184.215.14/hook');
  });

  it('AC12: PATCH { active: false } returns 200 with data.active false and no data.secret', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, {
      active: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.data['active']).toBe(false);
    expect(res.body.data).not.toHaveProperty('secret');
    expect(rowOf(webhook.id)?.active).toBe(false);
  });

  it('AC12 boundary: PATCH { active: false } returns the id and url of the webhook it updated', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, {
      active: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.data['id']).toBe(webhook.id);
    expect(res.body.data['url']).toBe('https://93.184.215.14/hook');
  });

  it('AC13: PATCH without webhook.update returns 403 and does not deactivate the webhook', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');
    currentPrincipal = memberPrincipal;

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, {
      active: false,
    });

    expect(res.status).toBe(403);
    expect(rowOf(webhook.id)?.active).toBe(true);
  });

  it('US-003: the production RequiresGuard refuses POST without webhook.create', async () => {
    currentPrincipal = memberPrincipal;

    const res = await callApi('POST', '/api/projects/alpha/webhooks', {
      url: 'https://93.184.215.14/hook',
      events: ['STATUS_CHANGE'],
    });

    expect(res.status).toBe(403);
    expect(store.webhooks).toHaveLength(0);
  });

  it('AC14: PATCH of a webhook owned by another project returns 404 and leaves that webhook untouched', async () => {
    const otherProjectWebhook = seedWebhook(projectB.id, 'https://93.184.215.14/other');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${otherProjectWebhook.id}`, {
      url: 'https://93.184.215.14/replaced',
    });

    expect(res.status).toBe(404);
    expect(rowOf(otherProjectWebhook.id)?.url).toBe('https://93.184.215.14/other');
  });

  it('AC16: POST with an unresolvable hostname returns 400 and creates no webhook', async () => {
    const res = await callApi('POST', '/api/projects/alpha/webhooks', {
      url: 'https://unresolvable.example/hook',
      events: ['STATUS_CHANGE'],
    });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('unresolvable');
    expect(store.webhooks).toHaveLength(0);
  });

  it('AC16: PATCH with an unresolvable hostname returns 400 and leaves the stored url unchanged', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, {
      url: 'https://unresolvable.example/hook',
    });

    expect(res.status).toBe(400);
    expect(rowOf(webhook.id)?.url).toBe('https://93.184.215.14/hook');
  });

  it('US-003 review: PATCH { events: null } returns 400 and leaves the stored events unchanged', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, { events: null });

    expect(res.status).toBe(400);
    expect(rowOf(webhook.id)?.events).toBe('["STATUS_CHANGE"]');
  });

  it('US-003 review: PATCH { secret: null } returns 400 instead of a 500 from the required column', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, { secret: null });

    expect(res.status).toBe(400);
    expect(rowOf(webhook.id)?.secret).toBe('seed-secret');
  });

  it('US-003 review: PATCH { active: null } returns 400 and leaves the webhook enabled', async () => {
    const webhook = seedWebhook(projectA.id, 'https://93.184.215.14/hook');

    const res = await callApi('PATCH', `/api/projects/alpha/webhooks/${webhook.id}`, { active: null });

    expect(res.status).toBe(400);
    expect(rowOf(webhook.id)?.active).toBe(true);
  });

  it('US-003 review: POST { events: null } returns 400 and creates no webhook', async () => {
    const res = await callApi('POST', '/api/projects/alpha/webhooks', {
      url: 'https://93.184.215.14/hook',
      events: null,
    });

    expect(res.status).toBe(400);
    expect(store.webhooks).toHaveLength(0);
  });
});
