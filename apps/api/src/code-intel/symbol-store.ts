import { Injectable, Inject } from '@nestjs/common';
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
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  async upsertSymbol(symbol: SymbolData): Promise<SymbolData> {
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
  }

  async findBySymbolId(projectId: string, symbolId: string): Promise<SymbolData | null> {
    const result = await this.db.symbol.findUnique({
      where: { projectId_symbolId: { projectId, symbolId } },
    });

    if (!result) return null;

    return {
      ...result,
      callers: (result.callers as unknown as string[]) || [],
      callees: (result.callees as unknown as string[]) || [],
    } as SymbolData;
  }

  async findCallers(projectId: string, symbolId: string): Promise<CallerInfo[]> {
    const symbols = await this.db.symbol.findMany({
      where: { projectId },
    });

    const callers = symbols
      .filter((s) => {
        const callersArr = (s.callers as unknown as string[]) || [];
        return callersArr.includes(symbolId);
      })
      .map((s) => ({
        symbolId: s.symbolId,
        file: s.file,
        name: s.name,
        kind: s.kind,
      }));

    return callers;
  }

  async findCallees(projectId: string, symbolId: string): Promise<CalleeInfo[]> {
    const symbol = await this.db.symbol.findUnique({
      where: { projectId_symbolId: { projectId, symbolId } },
    });

    if (!symbol) return [];

    const calleesArr = (symbol.callees as unknown as string[]) || [];

    if (calleesArr.length === 0) return [];

    const calleeSymbols = await this.db.symbol.findMany({
      where: {
        projectId,
        symbolId: { in: calleesArr },
      },
    });

    return calleeSymbols.map((s) => ({
      symbolId: s.symbolId,
      file: s.file,
      name: s.name,
      kind: s.kind,
    }));
  }

  async deleteByFile(projectId: string, repoId: string, file: string): Promise<void> {
    await this.db.symbol.deleteMany({
      where: { projectId, repoId, file },
    });
  }
}
