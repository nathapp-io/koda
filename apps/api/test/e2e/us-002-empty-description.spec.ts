/**
 * US-002: Remove empty-description guard in ticket create
 *
 * Acceptance Criteria:
 * - AC-1: description === '' → ticket.description === null
 * - AC-2: description === undefined → ticket.description === null
 * - AC-3: description === 'some text' → ticket.description === 'some text'
 * - AC-4: POST /api/projects/:slug/tickets with description: '' returns 201 with description === null
 */

import 'reflect-metadata';
import path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'child_process';
import request from 'supertest';

import { TicketsService } from '../../src/tickets/tickets.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests (AC-1, AC-2, AC-3)
// ─────────────────────────────────────────────────────────────────────────────

const mockProject = {
  id: 'proj-001',
  slug: 'koda',
  key: 'KODA',
  name: 'Koda',
  description: null,
  gitRemoteUrl: null,
  autoIndexOnClose: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const mockTicketBase = {
  id: 'ticket-001',
  projectId: 'proj-001',
  number: 1,
  type: 'BUG',
  title: 'Test',
  status: 'CREATED',
  priority: 'MEDIUM',
  assignedToUserId: null,
  assignedToAgentId: null,
  createdByUserId: 'user-001',
  createdByAgentId: null,
  gitRefVersion: null,
  gitRefFile: null,
  gitRefLine: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const mockUser = { id: 'user-001', sub: 'user-001' };

function buildMockPrisma() {
  return {
    client: {
      project: { findUnique: jest.fn() },
      ticket: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };
}

function stubTransaction(mockPrisma: ReturnType<typeof buildMockPrisma>) {
  mockPrisma.client.$transaction.mockImplementation(
    async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const tx = {
        ticket: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({ ...mockTicketBase, ...args.data, number: 1 }),
          ),
        },
      };
      return callback(tx as unknown as Record<string, unknown>);
    },
  );
}

describe('US-002: Empty description guard removed', () => {
  let service: TicketsService;
  let mockPrisma: ReturnType<typeof buildMockPrisma>;

  beforeEach(async () => {
    mockPrisma = buildMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<TicketsService>(TicketsService);
    mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
    stubTransaction(mockPrisma);
  });

  afterEach(() => jest.clearAllMocks());

  it('AC-1: description === "" → returned ticket has description === null', async () => {
    const result = await service.create(
      'koda',
      { type: 'BUG', title: 'T', description: '' } as never,
      mockUser,
      'user',
    );
    expect(result.description).toBeNull();
  });

  it('AC-2: description === undefined → returned ticket has description === null', async () => {
    const result = await service.create(
      'koda',
      { type: 'BUG', title: 'T' } as never,
      mockUser,
      'user',
    );
    expect(result.description).toBeNull();
  });

  it("AC-3: description === 'some text' → returned ticket has description === 'some text'", async () => {
    const result = await service.create(
      'koda',
      { type: 'BUG', title: 'T', description: 'some text' } as never,
      mockUser,
      'user',
    );
    expect(result.description).toBe('some text');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Test (AC-4)
// ─────────────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeIntegration('US-002: Integration test', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let userAccessToken: string;
  let projectSlug: string;

  const API_DIR = path.resolve(__dirname, '../../');

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    spawnSync(
      'bunx',
      ['prisma', 'db', 'push', '--force-reset', '--skip-generate'],
      { stdio: 'inherit', cwd: API_DIR, env: { ...process.env, DATABASE_URL } },
    );

    app = await AppFactory.create(AppModule);
    const combinedGuard = app.get(CombinedAuthGuard);
    app.setJwtAuthGuard(combinedGuard);
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    httpServer = app.getHttpServer();

    // Register admin user
    const regRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'us002@test.local', name: 'US-002 Tester', password: 'Admin1234!' });
    userAccessToken = regRes.body.data.accessToken;

    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const user = await prisma.client.user.findUnique({ where: { email: 'us002@test.local' } });
    if (user) {
      await prisma.client.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    }

    const loginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'us002@test.local', password: 'Admin1234!' });
    userAccessToken = loginRes.body.data.accessToken;

    // Create test project
    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ name: 'US-002 Test', slug: 'us-002-test', key: 'USEM', description: 'Test project' });
    projectSlug = body<{ slug: string }>(projectRes).slug;
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('AC-4: POST /api/projects/:slug/tickets with description: "" returns 201 with data.description === null', async () => {
    const res = await request(httpServer)
      .post(`/api/projects/${projectSlug}/tickets`)
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ type: 'BUG', title: 'Empty description test', description: '' })
      .expect(201);

    const data = body<{ description: string | null }>(res);
    expect(data.description).toBeNull();
  });
});
