import { Injectable, Inject, Optional } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Logger } from '@nestjs/common';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';

export interface SymbolData {
  id: string;
  symbolId: string;
  projectId: string;
  repoId: string;
  commitHash: string;
  name: string;
  kind: 'class' | 'method' | 'function' | 'interface' | 'enum';
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  callers: string[];
  callees: string[];
  docComment?: string;
}

export interface CallerInfo {
  symbolId: string;
  file: string;
  name: string;
  kind: string;
}

export interface CalleeInfo {
  symbolId: string;
  file: string;
  name: string;
  kind: string;
}

@Injectable()
export class SymbolStore {
  private readonly logger = new Logger(SymbolStore.name);

  constructor(
    private readonly codeIntelRepository: PrismaCodeIntelRepository,
    @Optional() @Inject(TRANSACTION_MANAGER) private readonly txManager?: ITransactionManager,
  ) {}

  async upsertSymbol(symbol: SymbolData): Promise<SymbolData> {
    const write = async () => {
      const result = await this.codeIntelRepository.upsertSymbol(symbol);
      return {
        ...result,
        callers: (result.callers as unknown as string[]) || [],
        callees: (result.callees as unknown as string[]) || [],
      } as SymbolData;
    };
    return this.txManager ? this.txManager.run(write) : write();
  }

  async findBySymbolId(projectId: string, symbolId: string): Promise<SymbolData | null> {
    const result = await this.findSymbolRecord(projectId, symbolId);

    if (!result) return null;

    return {
      ...result,
      callers: (result.callers as unknown as string[]) || [],
      callees: (result.callees as unknown as string[]) || [],
    } as SymbolData;
  }

  async findCallers(projectId: string, symbolId: string): Promise<CallerInfo[]> {
    const symbol = await this.findSymbolRecord(projectId, symbolId);

    if (!symbol) return [];

    const callerIds = (symbol.callers as unknown as string[]) || [];
    if (callerIds.length === 0) return [];

    const callerSymbols = await this.codeIntelRepository.findSymbolsByIds(projectId, callerIds);

    const found = new Map(callerSymbols.map((s) => [s.symbolId, s]));
    return callerIds.flatMap((id) => {
      const s = found.get(id);
      if (!s) return [];
      return [{
        symbolId: s.symbolId,
        file: s.file,
        name: s.name,
        kind: s.kind,
      }];
    });
  }

  async findCallees(projectId: string, symbolId: string): Promise<CalleeInfo[]> {
    const symbol = await this.findSymbolRecord(projectId, symbolId);

    if (!symbol) return [];

    const calleesArr = (symbol.callees as unknown as string[]) || [];

    if (calleesArr.length === 0) return [];

    const calleeSymbols = await this.codeIntelRepository.findSymbolsByIdsOrNames(
      projectId,
      calleesArr,
      calleesArr,
    );

    const found = new Map<string, typeof calleeSymbols[number]>();
    for (const s of calleeSymbols) {
      found.set(s.symbolId, s);
      found.set(s.name, s);
    }

    const result: CalleeInfo[] = [];
    for (const id of calleesArr) {
      const s = found.get(id);
      if (s) {
        result.push({ symbolId: s.symbolId, file: s.file, name: s.name, kind: s.kind });
      }
    }

    return result;
  }

  async deleteByFile(projectId: string, repoId: string, file: string): Promise<void> {
    await this.codeIntelRepository.deleteSymbolsByFile(projectId, repoId, file);
  }

  private async findSymbolRecord(projectId: string, symbolId: string) {
    const exact = await this.codeIntelRepository.findSymbolByExactId(projectId, symbolId);
    if (exact) return exact;

    const [fallback] = await this.codeIntelRepository.findSymbolsByFallback(projectId, symbolId);
    return fallback ?? null;
  }
}
