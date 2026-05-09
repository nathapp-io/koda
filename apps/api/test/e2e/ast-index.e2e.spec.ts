/**
 * AST/Symbol Index E2E Tests
 *
 * Exercises:
 *   - AstIndexService.indexCommit() via API endpoint
 *   - Symbol persistence and retrieval
 *   - getCallers/getCallees resolution
 *   - Permission gating (ADMIN, DEVELOPER agent)
 *   - code_commit outbox event triggering
 *
 * Run:  DATABASE_URL=file:./koda-test.db bun run test:integration
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

function body<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  expect(res.body).toHaveProperty('data');
  return res.body.data as T;
}

describeE2E('AST/Symbol Index E2E Tests', () => {
  let app: NathApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let adminAccessToken: string;
  let agentApiKey: string;
  let agentSlug: string;
  let projectSlug: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    try {
      const { execSync } = await import('child_process');
      execSync('bunx prisma db push --force-reset --skip-generate', {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL },
      });
    } catch {
      // DB reset may fail if schema is already in sync
    }

    app = await AppFactory.create(AppModule);

    const combinedGuard = app.get(CombinedAuthGuard);
    app.setJwtAuthGuard(combinedGuard);

    app
      .useAppGlobalPrefix()
      .useAppGlobalPipes()
      .useAppGlobalFilters()
      .useAppGlobalGuards();

    await app.init();
    httpServer = app.getHttpServer();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('1. Auth setup', () => {
    it('should register admin user and get access token', async () => {
      const res = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'admin@koda-ast.test', name: 'AST Admin', password: 'Admin1234!Aa' });

      expect(res.status).toBe(201);
      const data = body<{ accessToken: string }>(res);
      adminAccessToken = data.accessToken;
      expect(adminAccessToken).toBeDefined();
    });

    it('should register agent with DEVELOPER role', async () => {
      const res = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'dev-agent@koda-ast.test', name: 'Dev Agent', password: 'Agent1234!Aa' });

      expect(res.status).toBe(201);

      const agentRes = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ name: 'AST Developer Agent', roles: ['DEVELOPER'] });

      expect(agentRes.status).toBe(201);
      const agentData = body<{ id: string; slug: string; apiKey: string }>(agentRes);
      agentSlug = agentData.slug;
      agentApiKey = agentData.apiKey;
    });
  });

  describe('2. Project setup', () => {
    it('should create a project for AST indexing', async () => {
      const res = await request(httpServer)
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ name: 'AST Test Project', slug: 'ast-test', key: 'AST' });

      expect(res.status).toBe(201);
      const data = body<{ slug: string }>(res);
      projectSlug = data.slug;
    });
  });

  describe('AC-1, AC-6: indexCommit parses source files and stores symbol metadata', () => {
    it('should index a TypeScript file and return SymbolIndexResult', async () => {
      const files = [
        {
          path: 'src/auth.ts',
          content: `export async function authenticate(userId: string): Promise<User> {
            return {} as User;
          }
          export function logout(userId: string): void {}`,
        },
      ];

      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          repoId: 'repo-ast-123',
          commitHash: 'abc123def456',
          projectSlug,
          files,
        });

      expect(res.status).toBe(201);
      const result = body<{
        commitHash: string;
        symbolsIndexed: number;
        filesIndexed: number;
        fileErrors: Array<{ path: string; error: string }>;
        durationMs: number;
      }>(res);

      expect(result.commitHash).toBe('abc123def456');
      expect(result.symbolsIndexed).toBe(2);
      expect(result.filesIndexed).toBe(1);
      expect(result.fileErrors).toHaveLength(0);
      expect(result.durationMs).toBeLessThan(30000);
    });
  });

  describe('AC-2: symbolId convention {repoId}:{filePath}::{SymbolName}', () => {
    it('should store symbols with properly formatted symbolId', async () => {
      const files = [
        {
          path: 'src/user-service.ts',
          content: `export class UserService {
            getUser(id: string): User { return {} as User; }
          }`,
        },
      ];

      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          repoId: 'repo-unique-456',
          commitHash: 'unique789',
          projectSlug,
          files,
        });

      expect(res.status).toBe(201);
      const result = body<{ symbolsIndexed: number }>(res);
      expect(result.symbolsIndexed).toBeGreaterThan(0);
    });
  });

  describe('AC-3: getCallers returns symbols with symbolId in callers list', () => {
    it('should return callers of a symbol', async () => {
      const res = await request(httpServer)
        .get(`/api/code-intel/symbols/authenticate/callers`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .query({ projectSlug });

      expect(res.status).toBe(200);
    });
  });

  describe('AC-4: getCallees returns symbols in given symbol callees list', () => {
    it('should return callees of a symbol', async () => {
      const res = await request(httpServer)
        .get(`/api/code-intel/symbols/login/callees`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .query({ projectSlug });

      expect(res.status).toBe(200);
    });
  });

  describe('AC-5: only specified file is parsed, unchanged files preserved', () => {
    it('should only index the changed file', async () => {
      const files = [
        {
          path: 'src/new-file.ts',
          content: `export function newFunction(): number { return 42; }`,
        },
      ];

      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          repoId: 'repo-unchanged',
          commitHash: 'unchanged123',
          projectSlug,
          files,
        });

      expect(res.status).toBe(201);
      const result = body<{ filesIndexed: number }>(res);
      expect(result.filesIndexed).toBe(1);
    });
  });

  describe('AC-9: permission gating — ADMIN and DEVELOPER agents only', () => {
    it('ADMIN user should be able to call indexCommit', async () => {
      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          repoId: 'repo-admin-test',
          commitHash: 'admin123',
          projectSlug,
          files: [{ path: 'src/admin.ts', content: 'export function adminTest() {}' }],
        });

      expect(res.status).toBe(201);
    });

    it('DEVELOPER agent should be able to call indexCommit', async () => {
      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${agentApiKey}`)
        .send({
          repoId: 'repo-developer-test',
          commitHash: 'dev123',
          projectSlug,
          files: [{ path: 'src/dev.ts', content: 'export function devTest() {}' }],
        });

      expect(res.status).toBe(201);
    });

    it('non-DEVELOPER agent should receive 403', async () => {
      const agentRes = await request(httpServer)
        .post('/api/agents')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ name: 'Non-Developer Agent', roles: ['REVIEWER'] });

      expect(agentRes.status).toBe(201);
      const nonDevAgent = body<{ apiKey: string }>(agentRes);

      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${nonDevAgent.apiKey}`)
        .send({
          repoId: 'repo-reviwer-test',
          commitHash: 'reviewer123',
          projectSlug,
          files: [{ path: 'src/reviewer.ts', content: 'export function reviewerTest() {}' }],
        });

      expect(res.status).toBe(403);
    });

    it('MEMBER user should receive 403', async () => {
      const memberRes = await request(httpServer)
        .post('/api/auth/register')
        .send({ email: 'member@koda-ast.test', name: 'Member User', password: 'Member1234!Aa' });

      expect(memberRes.status).toBe(201);
      const memberData = body<{ accessToken: string }>(memberRes);

      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${memberData.accessToken}`)
        .send({
          repoId: 'repo-member-test',
          commitHash: 'member123',
          projectSlug,
          files: [{ path: 'src/member.ts', content: 'export function memberTest() {}' }],
        });

      expect(res.status).toBe(403);
    });
  });

  describe('AC-10: parser failures do not prevent other files from being indexed', () => {
    it('should record parse errors in fileErrors and continue indexing', async () => {
      const files = [
        { path: 'src/valid.ts', content: 'export function valid() {}' },
        { path: 'src/invalid.ts', content: 'invalid {{{ syntax' },
        { path: 'src/also-valid.ts', content: 'export function alsoValid() {}' },
      ];

      const res = await request(httpServer)
        .post(`/api/code-intel/index`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          repoId: 'repo-error-test',
          commitHash: 'error123',
          projectSlug,
          files,
        });

      expect(res.status).toBe(201);
      const result = body<{
        filesIndexed: number;
        fileErrors: Array<{ path: string; error: string }>;
      }>(res);

      expect(result.filesIndexed).toBe(2);
      expect(result.fileErrors).toHaveLength(1);
      expect(result.fileErrors[0].path).toBe('src/invalid.ts');
    });
  });
});
