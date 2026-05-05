import { Injectable, Logger } from '@nestjs/common';
import { CodeGraphService, ExtractedSymbol } from './code-graph.service';
import { SymbolStore, SymbolData, CallerInfo, CalleeInfo } from './symbol-store';

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

    const allExtractedSymbols: (ExtractedSymbol & { symbolId: string })[] = [];

    for (const file of files) {
      try {
        const parsed = this.codeGraph.parseSourceFile(file.path, file.content);
        const symbols = this.codeGraph.extractSymbols(parsed);

        for (const sym of symbols) {
          const symbolId = sym.name;
          const fullSymbol = this.enrichSymbol(sym, symbolId, repoId, commitHash, projectId, file.path);
          allExtractedSymbols.push({ ...sym, symbolId });
        }

        filesIndexed++;
      } catch (error) {
        fileErrors.push({
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.warn(`Failed to parse ${file.path}: ${error}`);
      }
    }

    for (const sym of allExtractedSymbols) {
      const callers = this.codeGraph.extractCallers(sym, allExtractedSymbols) || [];
      const callees = this.codeGraph.extractCallees(sym, allExtractedSymbols) || [];

      const fullId = `${repoId}:${sym.file}::${sym.name}`;

      const symbolData: SymbolData = {
        id: fullId,
        symbolId: sym.symbolId,
        projectId,
        repoId,
        commitHash,
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        signature: sym.signature,
        callers,
        callees,
        docComment: sym.docComment,
      };

      await this.symbolStore.upsertSymbol(symbolData);
      symbolsIndexed++;
    }

    const durationMs = Date.now() - startTime;

    return {
      commitHash,
      symbolsIndexed,
      filesIndexed,
      fileErrors,
      durationMs,
    };
  }

  async getSymbol(projectId: string, symbolId: string): Promise<Symbol | null> {
    const result = await this.symbolStore.findBySymbolId(projectId, symbolId);
    if (!result) return null;
    return this.toSymbol(result);
  }

  async getCallers(projectId: string, symbolId: string): Promise<CallerInfo[]> {
    return this.symbolStore.findCallers(projectId, symbolId);
  }

  async getCallees(projectId: string, symbolId: string): Promise<CalleeInfo[]> {
    return this.symbolStore.findCallees(projectId, symbolId);
  }

  private enrichSymbol(
    sym: ExtractedSymbol,
    symbolId: string,
    repoId: string,
    commitHash: string,
    projectId: string,
    filePath: string,
  ): ExtractedSymbol & { symbolId: string } {
    return { ...sym, symbolId };
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
