import { Test, TestingModule } from '@nestjs/testing';
import { CodeIntelModule } from './code-intel.module';
import { AstIndexService } from './ast-index.service';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

// ---------------------------------------------------------------------------
// AC11 — Module DI: search service and repository dependencies resolve
// ---------------------------------------------------------------------------
//
// Per project rules, DI-wiring tests are unit tests (no DB). They live here
// alongside the source, not in test/integration/, and run under `bun run test`.

describe('CodeIntelModule DI — searchSymbols chain (AC11)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, CodeIntelModule],
    }).compile();
  });

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('AC11: CodeIntelModule compiles with stubbed external collaborators', () => {
    expect(moduleRef).toBeDefined();
  });

  it('AC11: AstIndexService resolves from DI and exposes a searchSymbols method', () => {
    const svc = moduleRef.get(AstIndexService);
    expect(typeof (svc as unknown as Record<string, unknown>)['searchSymbols']).toBe('function');
  });

  it('AC11: PrismaCodeIntelRepository resolves from DI and exposes a searchSymbols method', () => {
    const repo = moduleRef.get(PrismaCodeIntelRepository);
    expect(typeof (repo as unknown as Record<string, unknown>)['searchSymbols']).toBe('function');
  });
});
