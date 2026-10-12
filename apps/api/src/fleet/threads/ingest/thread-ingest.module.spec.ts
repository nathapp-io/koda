import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../../common/test-helpers/global-stubs.module';
import { ThreadIngestBootstrap } from './thread-ingest.bootstrap';
import { THREAD_UNFOLDED_STREAM_SOURCE } from './domain/thread-ingest.domain';
import { ThreadIngestor } from './thread-ingestor';
import { ThreadIngestModule } from './thread-ingest.module';
import { PrismaThreadIngestRepository } from './prisma-thread-ingest.repository';

/**
 * DI guard, as threads.module.spec.ts: the startup catch-up is registered in this module and its
 * unfolded-stream source resolves to the Prisma repository. A missing provider or a broken wire fails `bun run test`.
 */
describe('ThreadIngestModule (US-007 wiring)', () => {
  it('compiles, registers the startup bootstrap, and binds its source to the repository', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ThreadIngestModule] }).compile();
    try {
      expect(moduleRef.get(ThreadIngestBootstrap)).toBeInstanceOf(ThreadIngestBootstrap);
      expect(moduleRef.get(THREAD_UNFOLDED_STREAM_SOURCE)).toBe(moduleRef.get(PrismaThreadIngestRepository));
    } finally {
      await moduleRef.close();
    }
  });

  it('US-007: Nest invokes the startup catch-up during app init, with no manual call', async () => {
    const source = { findUnfolded: vi.fn(async () => [{ jobId: 'J1', leaseEpoch: 1 }]) };
    const ingestor = { catchUp: vi.fn(async () => undefined) };
    @Module({
      providers: [
        ThreadIngestBootstrap,
        { provide: THREAD_UNFOLDED_STREAM_SOURCE, useValue: source },
        { provide: ThreadIngestor, useValue: ingestor },
      ],
    })
    class BootProbeModule {}
    const moduleRef = await Test.createTestingModule({ imports: [BootProbeModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    try {
      await app.init();
      expect(ingestor.catchUp).toHaveBeenCalledWith('J1', 1);
    } finally {
      await app.close();
    }
  });
});
