/**
 * Phase 2 — E2E integration test: ticket close → KB auto-index → search finds it.
 *
 * Flow:
 *   1. Create a project with autoIndexOnClose=true
 *   2. Create a ticket and transition it to IN_PROGRESS (closeable state)
 *   3. Close the ticket via TicketTransitionsService.close()
 *      → autoIndexTicket() fires and indexes the ticket in RagService
 *   4. Wait for async indexing to complete
 *   5. Call ragService.search() and assert the closed ticket is found
 *
 * Uses FakeEmbeddingService (no real model required) and in-memory LanceDB
 * fallback (temp directory set via ConfigService).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { RagService } from '../../../src/rag/rag.service';
import { TicketStatus } from '../../../src/common/enums';

jest.setTimeout(30000);

// Deterministic fake embeddings — same text always produces same vector
class FakeEmbeddingService {
  readonly providerName = 'fake';
  readonly modelName = 'fake-v1';
  readonly dimensions = 8;

  async embed(text: string): Promise<number[]> {
    const vec = Array.from({ length: 8 }, (_, i) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) >>> 0;
      return ((h + i * 1000) % 200) / 200;
    });
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe('RAG close-to-search integration', () => {
  let module: TestingModule;
  let ragService: RagService;
  let transitionsService: TicketTransitionsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: PrismaService<any>;
  let tmpDir: string;
  let projectId: string;
  let projectSlug: string;

  beforeAll(async () => {
    tmpDir = join(require('node:os').tmpdir(), `koda-rag-close-search-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { PrismaClient } = require('@prisma/client') as any;
    const fakeEmbedding = new FakeEmbeddingService();

    module = await Test.createTestingModule({
      providers: [
        {
          provide: 'PrismaService',
          useFactory: () => {
            return new PrismaService({
              client: PrismaClient,
              clientOptions: {},
            });
          },
        },
        TicketTransitionsService,
        // Provide RagService with a factory so we can inject FakeEmbeddingService directly
        {
          provide: RagService,
          useFactory: (configSvc: ConfigService) => {
            // EmbeddingService injected as 2nd constructor arg — bypass NestJS DI
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rag = new RagService(configSvc, fakeEmbedding as any);
            return rag;
          },
          inject: [ConfigService],
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const config: Record<string, unknown> = {
                'rag.lancedbPath': tmpDir,
                'rag.inMemoryOnly': true,
                'rag.similarityHigh': 0.85,
                'rag.similarityMedium': 0.70,
                'rag.similarityLow': 0.50,
              };
              return config[key];
            },
          },
        },
      ],
    }).compile();

    ragService = module.get(RagService);
    transitionsService = module.get(TicketTransitionsService);
    prisma = module.get('PrismaService');
    await prisma.client.$connect();

    // Create a test project with autoIndexOnClose enabled
    const slug = `rag-test-${Date.now()}`;
    const project = await prisma.client.project.create({
      data: {
        name: 'RAG Test Project',
        slug,
        key: `RAG${Date.now().toString().slice(-4)}`,
        autoIndexOnClose: true,
      },
    });
    projectId = project.id;
    projectSlug = slug;
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
    await module.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('closes a ticket and the KB search finds it', async () => {
    // ── Step 1: Create a ticket ──────────────────────────────────────────────
    const ticket = await prisma.client.ticket.create({
      data: {
        projectId,
        number: 1,
        type: 'BUG',
        title: 'Memory leak in worker pool on high load',
        description: 'Workers consume too much memory after processing 1000 tasks.',
        status: TicketStatus.CREATED,
        priority: 'HIGH',
      },
    });

    // ── Step 2: Transition to IN_PROGRESS (closeable state) ─────────────────
    // start() is allowed from CREATED → IN_PROGRESS
    await transitionsService.start(
      projectSlug,
      ticket.id,
      { id: 'test-user', sub: 'test-user' },
      'user',
    );

    // Verify ticket is in IN_PROGRESS
    const inProgressTicket = await prisma.client.ticket.findUnique({ where: { id: ticket.id } });
    expect(inProgressTicket?.status).toBe(TicketStatus.IN_PROGRESS);

    // ── Step 3: Close the ticket ─────────────────────────────────────────────
    // This fires autoIndexTicket() fire-and-forget
    await transitionsService.close(
      projectSlug,
      ticket.id,
      { id: 'test-user', sub: 'test-user' },
      'user',
    );

    // Verify ticket is CLOSED
    const closedTicket = await prisma.client.ticket.findUnique({ where: { id: ticket.id } });
    expect(closedTicket?.status).toBe(TicketStatus.CLOSED);

    // ── Step 4: Wait for async RAG indexing to complete ──────────────────────
    // autoIndexTicket is fire-and-forget; give it a moment to run
    await new Promise((resolve) => setTimeout(resolve, 500));

    // ── Step 5: Search the KB ───────────────────────────────────────────────
    // The ticket content contains "Memory leak in worker pool"
    const response = await ragService.search(
      projectId,
      'memory leak worker pool high load',
      5,
    );

    // ── Step 6: Assert results ──────────────────────────────────────────────
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.verdict).not.toBe('no_match');

    // The top result should contain the ticket content
    const topResult = response.results[0];
    expect(topResult.source).toBe('ticket');
    expect(topResult.sourceId).toBe(ticket.id);
    expect(topResult.content).toContain('Memory leak');
    expect(topResult.content).toContain('worker pool');

    // Score and similarity should be populated
    expect(typeof topResult.score).toBe('number');
    expect(['high', 'medium', 'low', 'none']).toContain(topResult.similarity);
  });

  it('search returns no_match when no ticket has been closed', async () => {
    // A fresh project with no closed tickets
    const freshProject = await prisma.client.project.create({
      data: {
        name: 'Fresh Project',
        slug: `fresh-${Date.now()}`,
        key: `FR${Date.now().toString().slice(-4)}`,
        autoIndexOnClose: true,
      },
    });

    const response = await ragService.search(freshProject.id, 'something', 5);
    expect(response.results).toEqual([]);
    expect(response.verdict).toBe('no_match');
  });
});
