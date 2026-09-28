import { Injectable, Logger, Inject } from '@nestjs/common';
import { CodeGraphService, ExtractedSymbol, ResolvedSymbol } from './code-graph.service';
import { SymbolStore, SymbolData, CallerInfo, CalleeInfo } from './symbol-store';
import { symbolFullId } from './symbol-id';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

export type { CallerInfo, CalleeInfo } from './symbol-store';

export interface SourceFile {
  path: string;
  content: string;
}

export interface SymbolIndexResult {
  commitHash: string;
  symbolsIndexed: number;
  filesIndexed: number;
  fileErrors: Array<{ path: string; error: string }>;
  durationMs: number;
}

export interface Symbol {
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

@Injectable()
export class AstIndexService {
  private readonly logger = new Logger(AstIndexService.name);

  constructor(
    private readonly codeGraph: CodeGraphService,
    private readonly symbolStore: SymbolStore,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async indexCommit(
    repoId: string,
    commitHash: string,
    files: SourceFile[],
    projectId: string,
  ): Promise<SymbolIndexResult> {
    const startTime = Date.now();
    const fileErrors: Array<{ path: string; error: string }> = [];
    let filesIndexed = 0;
    let symbolsIndexed = 0;

    const allExtractedSymbols: ResolvedSymbol[] = [];
    const parsedFiles: string[] = [];

    for (const file of files) {
      try {
        const parsed = this.codeGraph.parseSourceFile(file.path, file.content);
        const symbols = this.codeGraph.extractSymbols(parsed);

        for (const sym of symbols) {
          allExtractedSymbols.push({ ...sym, symbolId: '' });
        }

        filesIndexed++;
        parsedFiles.push(file.path);
      } catch (error) {
        fileErrors.push({
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.warn(`Failed to parse ${file.path}: ${error}`);
      }
    }

    this.assignSymbolIds(allExtractedSymbols);
    this.codeGraph.resolveRelationships(allExtractedSymbols);

    await this.txManager.run(async () => {
      // A re-indexed file is replaced, not merged: symbols its new version no
      // longer declares must not survive.
      for (const file of parsedFiles) {
        await this.symbolStore.deleteByFile(projectId, repoId, file);
      }

      for (const sym of allExtractedSymbols) {
        const fullId = symbolFullId(projectId, repoId, sym.file, sym.symbolId);

        const symbolData: SymbolData = {
          id: fullId,
          symbolId: fullId,
          projectId,
          repoId,
          commitHash,
          name: sym.name,
          kind: sym.kind,
          file: sym.file,
          startLine: sym.startLine,
          endLine: sym.endLine,
          signature: sym.signature,
          callers: sym.callers.map((callerId) => {
            const caller = allExtractedSymbols.find((candidate) => candidate.symbolId === callerId);
            return symbolFullId(projectId, repoId, caller?.file ?? sym.file, callerId);
          }),
          callees: sym.callees.map((calleeId) => {
            const callee = allExtractedSymbols.find((candidate) => candidate.symbolId === calleeId);
            return symbolFullId(projectId, repoId, callee?.file ?? sym.file, calleeId);
          }),
          docComment: sym.docComment,
        };

        await this.symbolStore.upsertSymbol(symbolData);
        symbolsIndexed++;
      }
    });

    const durationMs = Date.now() - startTime;

    return {
      commitHash,
      symbolsIndexed,
      filesIndexed,
      fileErrors,
      durationMs,
    };
  }

  /** Drop the symbols of files a commit deleted (renames arrive as removed + added). */
  async removeFiles(projectId: string, repoId: string, files: string[]): Promise<void> {
    await this.txManager.run(async () => {
      for (const file of files) {
        await this.symbolStore.deleteByFile(projectId, repoId, file);
      }
    });
  }

  async getSymbol(projectId: string, symbolId: string): Promise<Symbol | null> {
    const result = await this.symbolStore.findBySymbolId(projectId, symbolId);
    if (!result) return null;
    return this.toSymbol(result);
  }

  async searchSymbols(
    projectId: string,
    opts: { q?: string; file?: string; page?: number; limit?: number },
  ) {
    return this.symbolStore.searchSymbols(projectId, opts);
  }

  async getCallers(projectId: string, symbolId: string): Promise<CallerInfo[]> {
    return this.symbolStore.findCallers(projectId, symbolId);
  }

  async getCallees(projectId: string, symbolId: string): Promise<CalleeInfo[]> {
    return this.symbolStore.findCallees(projectId, symbolId);
  }

  private assignSymbolIds(symbols: ResolvedSymbol[]): void {
    const fileCounts = new Map<string, Map<string, number>>();

    for (const sym of symbols) {
      let nameCounts = fileCounts.get(sym.file);
      if (!nameCounts) {
        nameCounts = new Map<string, number>();
        fileCounts.set(sym.file, nameCounts);
      }
      const count = (nameCounts.get(sym.name) || 0) + 1;
      nameCounts.set(sym.name, count);

      if (count === 1) {
        sym.symbolId = sym.name;
      } else {
        sym.symbolId = `${sym.name}#${count}`;
      }
    }
  }

  private toSymbol(data: SymbolData): Symbol {
    return {
      id: data.id,
      symbolId: data.symbolId,
      projectId: data.projectId,
      repoId: data.repoId,
      commitHash: data.commitHash,
      name: data.name,
      kind: data.kind,
      file: data.file,
      startLine: data.startLine,
      endLine: data.endLine,
      signature: data.signature,
      callers: data.callers,
      callees: data.callees,
      docComment: data.docComment,
    };
  }
}
