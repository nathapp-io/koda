import { Test, TestingModule } from '@nestjs/testing';
import { SymbolStore, SymbolData } from './symbol-store';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

function makeSymbol(overrides: Partial<SymbolData> = {}): SymbolData {
  return {
    id: 'sym-1',
    symbolId: 'repo-1:src/auth.ts::AuthService',
    projectId: 'proj-1',
    repoId: 'repo-1',
    commitHash: 'abc123',
    name: 'AuthService',
    kind: 'class',
    file: 'src/auth.ts',
    startLine: 10,
    endLine: 50,
    callers: [],
    callees: [],
    ...overrides,
  };
}

function makeDbSymbolRow(data: SymbolData) {
  return { ...data, callers: data.callers as unknown as string[], callees: data.callees as unknown as string[] };
}

function makeRepositoryMock() {
  return {
    upsertSymbol: jest.fn(),
    findSymbolByExactId: jest.fn(),
    findSymbolsByFallback: jest.fn(),
    findSymbolsByIds: jest.fn(),
    findSymbolsByIdsOrNames: jest.fn(),
    deleteSymbolsByFile: jest.fn(),
  };
}

describe('SymbolStore', () => {
  let store: SymbolStore;
  let repoMethods: ReturnType<typeof makeRepositoryMock>;

  beforeEach(async () => {
    repoMethods = makeRepositoryMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SymbolStore,
        { provide: PrismaCodeIntelRepository, useValue: repoMethods },
        { provide: TRANSACTION_MANAGER, useValue: undefined },
      ],
    }).compile();

    store = module.get(SymbolStore);
  });

  describe('upsertSymbol', () => {
    it('delegates to repository upsertSymbol and returns SymbolData', async () => {
      const sym = makeSymbol();
      repoMethods.upsertSymbol.mockResolvedValue(makeDbSymbolRow(sym));
      const result = await store.upsertSymbol(sym);
      expect(repoMethods.upsertSymbol).toHaveBeenCalledWith(sym);
      expect(result.symbolId).toBe(sym.symbolId);
    });

    it('coerces null callers/callees to empty arrays', async () => {
      const sym = makeSymbol();
      repoMethods.upsertSymbol.mockResolvedValue({ ...makeDbSymbolRow(sym), callers: null, callees: null });
      const result = await store.upsertSymbol(sym);
      expect(result.callers).toEqual([]);
      expect(result.callees).toEqual([]);
    });
  });

  describe('findBySymbolId', () => {
    it('returns null when symbol is not found', async () => {
      repoMethods.findSymbolByExactId.mockResolvedValue(null);
      repoMethods.findSymbolsByFallback.mockResolvedValue([]);
      const result = await store.findBySymbolId('proj-1', 'missing');
      expect(result).toBeNull();
    });

    it('returns SymbolData when exact match found', async () => {
      const sym = makeSymbol();
      repoMethods.findSymbolByExactId.mockResolvedValue(makeDbSymbolRow(sym));
      const result = await store.findBySymbolId('proj-1', sym.symbolId);
      expect(result?.symbolId).toBe(sym.symbolId);
    });

    it('falls back to name/suffix match when exact lookup misses', async () => {
      const sym = makeSymbol();
      repoMethods.findSymbolByExactId.mockResolvedValue(null);
      repoMethods.findSymbolsByFallback.mockResolvedValue([makeDbSymbolRow(sym)]);
      const result = await store.findBySymbolId('proj-1', 'AuthService');
      expect(result?.name).toBe('AuthService');
    });
  });

  describe('findCallers', () => {
    it('returns empty array when symbol not found', async () => {
      repoMethods.findSymbolByExactId.mockResolvedValue(null);
      repoMethods.findSymbolsByFallback.mockResolvedValue([]);
      const result = await store.findCallers('proj-1', 'missing');
      expect(result).toHaveLength(0);
    });

    it('returns empty array when symbol has no callers', async () => {
      const sym = makeSymbol({ callers: [] });
      repoMethods.findSymbolByExactId.mockResolvedValue(makeDbSymbolRow(sym));
      const result = await store.findCallers('proj-1', sym.symbolId);
      expect(result).toHaveLength(0);
    });

    it('returns caller info objects for each caller symbolId', async () => {
      const callerSym = makeSymbol({ id: 'sym-2', symbolId: 'repo-1:src/app.ts::bootstrap', name: 'bootstrap', kind: 'function' });
      const sym = makeSymbol({ callers: [callerSym.symbolId] });
      repoMethods.findSymbolByExactId.mockResolvedValue(makeDbSymbolRow(sym));
      repoMethods.findSymbolsByIds.mockResolvedValue([makeDbSymbolRow(callerSym)]);
      const result = await store.findCallers('proj-1', sym.symbolId);
      expect(result).toHaveLength(1);
      expect(result[0].symbolId).toBe(callerSym.symbolId);
    });
  });

  describe('findCallees', () => {
    it('returns empty array when symbol not found', async () => {
      repoMethods.findSymbolByExactId.mockResolvedValue(null);
      repoMethods.findSymbolsByFallback.mockResolvedValue([]);
      const result = await store.findCallees('proj-1', 'missing');
      expect(result).toHaveLength(0);
    });

    it('returns empty array when symbol has no callees', async () => {
      const sym = makeSymbol({ callees: [] });
      repoMethods.findSymbolByExactId.mockResolvedValue(makeDbSymbolRow(sym));
      const result = await store.findCallees('proj-1', sym.symbolId);
      expect(result).toHaveLength(0);
    });
  });

  describe('deleteByFile', () => {
    it('delegates to repository deleteSymbolsByFile', async () => {
      repoMethods.deleteSymbolsByFile.mockResolvedValue(undefined);
      await store.deleteByFile('proj-1', 'repo-1', 'src/auth.ts');
      expect(repoMethods.deleteSymbolsByFile).toHaveBeenCalledWith('proj-1', 'repo-1', 'src/auth.ts');
    });
  });
});
