/**
 * US-001 — the project brief over a real Fastify HTTP server.
 *
 * The controller, `ProjectsService`, the `UpdateProjectDto` validation pipe and
 * the real `PrismaProjectRepository` (so the Prisma → domain mapping of
 * `brief` is exercised) are all real. Only the database is fake:
 * `PrismaService.client.project` is an in-memory store of Project rows that
 * mirrors the column semantics Prisma gives a nullable `String?` column — an
 * absent (`undefined`) field leaves the column untouched, `null` clears it.
 *
 * The DB-backed form of the same acceptance criteria lives in
 * `test/e2e/api-endpoint/endpoint.e2e.spec.ts` (AC-7 — the 403 for a project
 * member who is not a project admin — only exists there: it needs the
 * production `CombinedAuthGuard` and the real `PermissionService` behind the
 * route's `@Requires('project.update')`, which this module stands in for).
 */
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { ProjectAccessService } from './project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { RagService } from '../rag/rag.service';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { AgentsService } from '../agents/agents.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  key: string;
  description: string | null;
  brief: string | null;
  gitRemoteUrl: string | null;
  autoIndexOnClose: boolean;
  autoAssign: string;
  graphifyEnabled: boolean;
  graphifyLastImportedAt: Date | null;
  ciWebhookToken: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'proj-1',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Fleet platform',
    brief: 'Koda is a fleet platform.',
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
    ciWebhookToken: null,
    deletedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

const adminPrincipal: KodaPrincipal = {
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

describe('PATCH /api/projects/:slug — the project brief (US-001)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;
  let rows: ProjectRow[];

  beforeEach(async () => {
    rows = [projectRow()];

    const prisma = createMockPrismaService({ fn: vi.fn });
    const findUnique = vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) =>
      rows.find((row) => (where.slug !== undefined ? row.slug === where.slug : row.id === where.id)) ?? null,
    );
    const update = vi.fn(async ({ where, data }: { where: { slug: string }; data: Partial<ProjectRow> }) => {
      const row = rows.find((r) => r.slug === where.slug);
      if (!row) throw new Error(`no Project row for slug ${where.slug}`);
      // Prisma skips `undefined` columns and writes `null` as SQL NULL.
      Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
      return { ...row };
    });
    prisma.client.project = { findUnique, update } as never;

    testingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        ProjectsService,
        { provide: AuditRecorder, useValue: { audited: vi.fn(async (fn: () => Promise<unknown>) => fn()) } },
        PrismaProjectRepository,
        ProjectAccessService,
        { provide: PrismaService, useValue: prisma },
        { provide: RagService, useValue: { deleteAllBySourceType: vi.fn(), clearProjectCaches: vi.fn() } },
        { provide: HybridRetrieverService, useValue: { invalidateGraphifyEnabledCache: vi.fn() } },
        { provide: ImpactAnalysisService, useValue: { getChangeImpact: vi.fn() } },
        { provide: AgentsService, useValue: { listProjectRoster: vi.fn() } },
        // US-007: the migrated PATCH/GET routes declare `project.update` / `project.read`; this double
        // is the key check, so the cases below still reach the handler and its validation.
        { provide: PermissionService, useValue: { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) } },
      ],
    }).compile();

    app = testingModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');

    // Stands in for the global CombinedAuthGuard: `GET /api/projects/:slug` is
    // guarded by ProjectMembershipGuard, which reads the principal off the
    // request.
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = adminPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);
    // The same options `useAppGlobalPipes()` installs in production.
    app.useGlobalPipes(new ValidationPipe({ forbidUnknownValues: false, stopAtFirstError: true, whitelist: true }));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  const patch = async (body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/projects/koda', payload: body });

  const get = async () => app.inject({ method: 'GET', url: '/api/projects/koda' });

  it('AC-1: answers 200 and echoes the brief it stored', async () => {
    const res = await patch({ brief: 'Koda is a fleet platform.' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief).toBe('Koda is a fleet platform.');
    expect(rows[0].brief).toBe('Koda is a fleet platform.');
  });

  it('AC-2: the following GET returns the stored brief', async () => {
    rows[0].brief = null;

    await patch({ brief: 'Koda is a fleet platform.' });

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief).toBe('Koda is a fleet platform.');
  });

  it('AC-3: a null brief answers 200 with null and clears the column', async () => {
    const res = await patch({ brief: null });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief).toBeNull();
    expect(rows[0].brief).toBeNull();

    const after = await get();
    expect(after.json().data.brief).toBeNull();
  });

  it('AC-4: a 3001-character brief answers 400 and leaves the stored brief alone', async () => {
    const res = await patch({ brief: 'k'.repeat(3001) });

    expect(res.statusCode).toBe(400);
    expect(rows[0].brief).toBe('Koda is a fleet platform.');

    const after = await get();
    expect(after.json().data.brief).toBe('Koda is a fleet platform.');
  });

  it('AC-5: a brief of exactly 3000 characters answers 200', async () => {
    const brief = 'x'.repeat(3000);

    const res = await patch({ brief });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief).toBe(brief);
    expect(rows[0].brief).toHaveLength(3000);
  });

  it('AC-6: a non-string brief answers 400 and leaves the stored brief alone', async () => {
    const res = await patch({ brief: 42 });

    expect(res.statusCode).toBe(400);
    expect(rows[0].brief).toBe('Koda is a fleet platform.');
  });

  it('stores an empty string as given', async () => {
    const res = await patch({ brief: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief).toBe('');
    expect(rows[0].brief).toBe('');
  });

  it('leaves the brief untouched when the PATCH omits it', async () => {
    const res = await patch({ description: 'Renamed description' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief).toBe('Koda is a fleet platform.');
    expect(rows[0].description).toBe('Renamed description');
  });
});
