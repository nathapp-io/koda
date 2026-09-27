/**
 * US-004: project create/update conflict responses at the HTTP boundary.
 *
 * Acceptance Criteria:
 * 1.  POST /api/projects returns 409 when a project with the requested slug already exists.
 * 2.  POST /api/projects returns 409 when a project with the requested key already exists.
 * 3.  PATCH /api/projects/:slug returns 404 when the project is soft-deleted.
 * 15. PATCH /api/projects/:slug returns 409 when the requested slug or key belongs to another project.
 *
 * These tests boot the real ProjectsController + ProjectsService wired exactly
 * as production wires them (Nathapp's GlobalExceptionsFilter maps an app
 * exception to its HTTP status) with only the persistence layer mocked, then
 * drive real HTTP requests through supertest — so the asserted status code is
 * the status code the endpoint returns.
 *
 * The routes are mounted without the `/api` global prefix here; the prefix is
 * added by `AppFactory` in the DB-backed e2e suite (`test/e2e/api-endpoint`).
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { GlobalExceptionsFilter } from '@nathapp/nestjs-common';
import { ProjectsController } from '../../../src/projects/projects.controller';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ProjectAccessService } from '../../../src/projects/project-access.service';
import { PrismaProjectRepository } from '../../../src/projects/prisma-project.repository';
import { RagService } from '../../../src/rag/rag.service';
import { ImpactAnalysisService } from '../../../src/code-intel/impact-analysis.service';
import { AgentsService } from '../../../src/agents/agents.service';
import type { ProjectDomain } from '../../../src/projects/domain/project.domain';

const ALPHA_PROJECT: ProjectDomain = {
  id: 'project-alpha',
  name: 'Alpha',
  slug: 'alpha',
  key: 'ALPH',
  description: null,
  gitRemoteUrl: null,
  autoIndexOnClose: true,
  autoAssign: 'OFF',
  graphifyEnabled: false,
  graphifyLastImportedAt: null,
  ciWebhookToken: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const OTHER_PROJECT: ProjectDomain = {
  ...ALPHA_PROJECT,
  id: 'project-other',
  name: 'Other',
  slug: 'taken-slug',
  key: 'TKEN',
};

describe('US-004: project conflict responses', () => {
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  const projectRepo = {
    findBySlug: jest.fn(),
    findByKey: jest.fn(),
    findAll: jest.fn(),
    findAllForUser: jest.fn(),
    createProject: jest.fn(),
    updateBySlug: jest.fn(),
    findAllIds: jest.fn(),
    findMembershipRole: jest.fn(),
  };

  const ragService = {
    deleteAllBySourceType: jest.fn(),
    clearProjectCaches: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        ProjectsService,
        ProjectAccessService,
        { provide: PrismaProjectRepository, useValue: projectRepo },
        { provide: RagService, useValue: ragService },
        { provide: ImpactAnalysisService, useValue: {} },
        { provide: AgentsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionsFilter(app.get(HttpAdapterHost)));
    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    projectRepo.createProject.mockImplementation(async (data: { name: string; slug: string; key: string }) => ({
      ...ALPHA_PROJECT,
      ...data,
    }));
    projectRepo.updateBySlug.mockResolvedValue(ALPHA_PROJECT);
  });

  describe('POST /projects', () => {
    it('AC1: returns 409 when the requested slug already exists', async () => {
      projectRepo.findBySlug.mockResolvedValue(ALPHA_PROJECT);

      const res = await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'alpha', key: 'BETA' });

      expect(res.status).toBe(409);
    });

    it('AC1: does not create the project when the slug already exists', async () => {
      projectRepo.findBySlug.mockResolvedValue(ALPHA_PROJECT);

      await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'alpha', key: 'BETA' });

      expect(projectRepo.createProject).not.toHaveBeenCalled();
    });

    it('AC2: returns 409 when the requested key already exists', async () => {
      projectRepo.findBySlug.mockResolvedValue(null);
      projectRepo.findByKey.mockResolvedValue(ALPHA_PROJECT);

      const res = await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'beta-project', key: 'ALPH' });

      expect(res.status).toBe(409);
    });

    it('AC2: does not create the project when the key already exists', async () => {
      projectRepo.findBySlug.mockResolvedValue(null);
      projectRepo.findByKey.mockResolvedValue(ALPHA_PROJECT);

      await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'beta-project', key: 'ALPH' });

      expect(projectRepo.createProject).not.toHaveBeenCalled();
    });

    it('creates the project (201) when both slug and key are free', async () => {
      projectRepo.findBySlug.mockResolvedValue(null);
      projectRepo.findByKey.mockResolvedValue(null);

      const res = await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'beta-project', key: 'BETA' });

      expect(res.status).toBe(201);
      expect(projectRepo.createProject).toHaveBeenCalled();
    });

    it('still rejects an invalid key format with 400, even when the slug is taken', async () => {
      projectRepo.findBySlug.mockResolvedValue(ALPHA_PROJECT);

      const res = await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'alpha', key: 'lowercase' });

      expect(res.status).toBe(400);
    });

    it('still rejects an invalid slug format with 400', async () => {
      const res = await request(httpServer)
        .post('/projects')
        .send({ name: 'Beta Project', slug: 'Not_A_Slug', key: 'BETA' });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /projects/:slug', () => {
    it('AC3: returns 404 when the project is soft-deleted', async () => {
      projectRepo.findBySlug.mockResolvedValue({ ...ALPHA_PROJECT, deletedAt: new Date() });

      const res = await request(httpServer)
        .patch('/projects/alpha')
        .send({ name: 'Renamed Alpha' });

      expect(res.status).toBe(404);
    });

    it('AC3: does not update a soft-deleted project', async () => {
      projectRepo.findBySlug.mockResolvedValue({ ...ALPHA_PROJECT, deletedAt: new Date() });

      await request(httpServer)
        .patch('/projects/alpha')
        .send({ name: 'Renamed Alpha' });

      expect(projectRepo.updateBySlug).not.toHaveBeenCalled();
    });

    it('AC15: returns 409 when the requested slug belongs to another project', async () => {
      projectRepo.findBySlug.mockImplementation(async (slug: string) => {
        if (slug === 'alpha') return ALPHA_PROJECT;
        if (slug === 'taken-slug') return OTHER_PROJECT;
        return null;
      });

      const res = await request(httpServer)
        .patch('/projects/alpha')
        .send({ slug: 'taken-slug' });

      expect(res.status).toBe(409);
      expect(projectRepo.updateBySlug).not.toHaveBeenCalled();
    });

    it('AC15: returns 409 when the requested key belongs to another project', async () => {
      projectRepo.findBySlug.mockResolvedValue(ALPHA_PROJECT);
      projectRepo.findByKey.mockResolvedValue(OTHER_PROJECT);

      const res = await request(httpServer)
        .patch('/projects/alpha')
        .send({ key: 'TKEN' });

      expect(res.status).toBe(409);
      expect(projectRepo.updateBySlug).not.toHaveBeenCalled();
    });

    it('allows a PATCH that keeps the project slug unchanged (200)', async () => {
      projectRepo.findBySlug.mockResolvedValue(ALPHA_PROJECT);

      const res = await request(httpServer)
        .patch('/projects/alpha')
        .send({ slug: 'alpha' });

      expect(res.status).toBe(200);
      expect(projectRepo.updateBySlug).toHaveBeenCalled();
    });

    it('allows a PATCH that keeps the project key unchanged (200)', async () => {
      projectRepo.findBySlug.mockResolvedValue(ALPHA_PROJECT);
      projectRepo.findByKey.mockResolvedValue(ALPHA_PROJECT);

      const res = await request(httpServer)
        .patch('/projects/alpha')
        .send({ key: 'ALPH' });

      expect(res.status).toBe(200);
      expect(projectRepo.updateBySlug).toHaveBeenCalled();
    });

    it('returns 404 for a project that does not exist at all', async () => {
      projectRepo.findBySlug.mockResolvedValue(null);

      const res = await request(httpServer)
        .patch('/projects/missing')
        .send({ name: 'Renamed Alpha' });

      expect(res.status).toBe(404);
    });
  });
});
