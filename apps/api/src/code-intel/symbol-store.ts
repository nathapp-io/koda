import { Injectable, Inject, Optional } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';

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
    private readonly prisma: PrismaService<PrismaClient>,
    @Optional() @Inject(TRANSACTION_MANAGER) private readonly txManager?: ITransactionManager,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  async upsertSymbol(symbol: SymbolData): Promise<SymbolData> {
    const write = async () => {
      const data = {
        ...symbol,
        callers: symbol.callers as unknown as string[],
        callees: symbol.callees as unknown as string[],
      };

      const result = await this.db.symbol.upsert({
        where: { id: symbol.id },
        create: data as Parameters<typeof this.db.symbol.upsert>[0]['create'],
        update: data as Parameters<typeof this.db.symbol.upsert>[0]['update'],
      });

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

    const callerSymbols = await this.db.symbol.findMany({
      where: {
        projectId,
        symbolId: { in: callerIds },
      },
    });

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

    const calleeSymbols = await this.db.symbol.findMany({
      where: {
        projectId,
        OR: [
          { symbolId: { in: calleesArr } },
          { name: { in: calleesArr } },
        ],
      },
    });

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
    await this.db.symbol.deleteMany({
      where: { projectId, repoId, file },
    });
  }

  private async findSymbolRecord(projectId: string, symbolId: string) {
    const exact = await this.db.symbol.findUnique({
      where: { projectId_symbolId: { projectId, symbolId } },
    });
    if (exact) return exact;

    const [fallback] = await this.db.symbol.findMany({
      where: {
        projectId,
        OR: [
          { symbolId: { endsWith: `::${symbolId}` } },
          { name: symbolId },
        ],
      },
      take: 1,
    });
    return fallback ?? null;
  }
}
