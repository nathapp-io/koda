import { Injectable, Logger } from '@nestjs/common';
import type { Project, SourceFile } from 'ts-morph';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

export interface ParsedSourceFile {
  path: string;
  content: string;
  ast: SourceFile;
}

export interface ExtractedSymbol {
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

export interface ResolvedSymbol extends ExtractedSymbol {
  symbolId: string;
}

export type FileExtraction =
  | { path: string; symbols: ExtractedSymbol[] }
  | { path: string; error: string };

let projectConstructor: typeof Project | undefined;

function createProject(): Project {
  // Loading ts-morph also loads its TypeScript compiler. Defer both until the first parse.
  projectConstructor ??= (require('ts-morph') as typeof import('ts-morph')).Project;
  return new projectConstructor({ useInMemoryFileSystem: true });
}

@Injectable()
export class CodeGraphService {
  private readonly logger = new Logger(CodeGraphService.name);

  parseSourceFile(path: string, content: string): ParsedSourceFile {
    const project = createProject();
    const sourceFile = project.createSourceFile(path, content);
    this.rejectSyntacticErrors(project, sourceFile);
    return { path, content, ast: sourceFile };
  }

  extractBatch(files: ReadonlyArray<{ path: string; content: string }>): FileExtraction[] {
    if (files.length === 0) return [];

    const project = createProject();
    const results: FileExtraction[] = [];

    for (const { path, content } of files) {
      let sourceFile: SourceFile | undefined;
      try {
        sourceFile = project.createSourceFile(path, content, { overwrite: true });
        this.rejectSyntacticErrors(project, sourceFile);
        const parsed = { path, content, ast: sourceFile };
        results.push({ path, symbols: this.extractSymbols(parsed) });
      } catch (error) {
        results.push({ path, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (sourceFile) project.removeSourceFile(sourceFile);
      }
    }

    return results;
  }

  private rejectSyntacticErrors(project: Project, sourceFile: SourceFile): void {
    const syntaxErrors = project
      .getProgram()
      .getSyntacticDiagnostics(sourceFile)
      .filter((diagnostic) => diagnostic.getCategory() === 1);
    if (syntaxErrors.length > 0) {
      const messages = syntaxErrors.map((diagnostic) => diagnostic.getMessageText().toString()).join('; ');
      throw new Error(`Parse error: ${messages}`);
    }
  }

  extractSymbols(parsed: ParsedSourceFile): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const sourceFile = parsed.ast;

    const classes = sourceFile.getClasses();
    for (const cls of classes) {
      const className = cls.getName() || 'anonymous';
      symbols.push({
        name: className,
        kind: 'class',
        file: parsed.path,
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        signature: undefined,
        callers: [],
        callees: [],
        docComment: cls.getJsDocs().map((d: AnyNode) => d.getText()).join('\n') || undefined,
      });

      for (const method of cls.getMethods()) {
        symbols.push(this.extractMethodSymbol(method, className, parsed.path));
      }
    }

    const functions = sourceFile.getFunctions();
    for (const func of functions) {
      symbols.push(this.extractFunctionSymbol(func, parsed.path));
    }

    const interfaces = sourceFile.getInterfaces();
    for (const iface of interfaces) {
      symbols.push({
        name: iface.getName(),
        kind: 'interface',
        file: parsed.path,
        startLine: iface.getStartLineNumber(),
        endLine: iface.getEndLineNumber(),
        signature: undefined,
        callers: [],
        callees: [],
        docComment: iface.getJsDocs().map((d: AnyNode) => d.getText()).join('\n') || undefined,
      });
    }

    const enums = sourceFile.getEnums();
    for (const enm of enums) {
      symbols.push({
        name: enm.getName(),
        kind: 'enum',
        file: parsed.path,
        startLine: enm.getStartLineNumber(),
        endLine: enm.getEndLineNumber(),
        signature: undefined,
        callers: [],
        callees: [],
        docComment: enm.getJsDocs().map((d: AnyNode) => d.getText()).join('\n') || undefined,
      });
    }

    const variableDeclarations = sourceFile.getVariableDeclarations();
    for (const varDecl of variableDeclarations) {
      const initializer = varDecl.getInitializer();
      if (initializer) {
        const kindName = initializer.getKindName();
        if (kindName === 'ArrowFunction' || kindName === 'FunctionExpression') {
          const statement = varDecl.getParent()?.getParent();
          symbols.push(this.extractFunctionSymbol(initializer, parsed.path, varDecl.getName(), statement));
        }
      }
    }

    return symbols;
  }

  private getShortName(name: string): string {
    const parts = name.split('.');
    return parts[parts.length - 1];
  }

  resolveRelationships(symbols: ResolvedSymbol[]): void {
    const nameToSymbolIds = new Map<string, string[]>();

    for (const sym of symbols) {
      const shortName = this.getShortName(sym.name);

      if (!nameToSymbolIds.has(sym.name)) nameToSymbolIds.set(sym.name, []);
      const symList = nameToSymbolIds.get(sym.name);
      if (symList) symList.push(sym.symbolId);

      if (shortName !== sym.name) {
        if (!nameToSymbolIds.has(shortName)) nameToSymbolIds.set(shortName, []);
        const shortList = nameToSymbolIds.get(shortName);
        if (shortList && !shortList.includes(sym.symbolId)) {
          shortList.push(sym.symbolId);
        }
      }
    }

    const calleeToCallerIds = new Map<string, string[]>();

    for (const sym of symbols) {
      const resolvedCalleeIds: string[] = [];

      for (const rawCallee of sym.callees) {
        if (rawCallee === sym.name) continue;
        if (rawCallee === this.getShortName(sym.name)) continue;

        const resolvedIds = nameToSymbolIds.get(rawCallee) || [];
        resolvedCalleeIds.push(...resolvedIds);
      }

      const uniqueCallees = [...new Set(resolvedCalleeIds)];
      sym.callees = uniqueCallees;

      for (const calleeId of uniqueCallees) {
        if (!calleeToCallerIds.has(calleeId)) calleeToCallerIds.set(calleeId, []);
        const callerList = calleeToCallerIds.get(calleeId);
        if (callerList) callerList.push(sym.symbolId);
      }
    }

    for (const sym of symbols) {
      sym.callers = calleeToCallerIds.get(sym.symbolId) || [];
    }
  }

  extractCallers(symbol: ExtractedSymbol, allSymbols: ExtractedSymbol[]): string[] {
    const callers: string[] = [];
    const shortName = this.getShortName(symbol.name);

    for (const other of allSymbols) {
      if (other.name === symbol.name && other.file === symbol.file) continue;
      if (other.callees.includes(symbol.name) || other.callees.includes(shortName)) {
        callers.push(other.name);
      }
    }
    return callers;
  }

  extractCallees(symbol: ExtractedSymbol, allSymbols: ExtractedSymbol[]): string[] {
    const { name } = symbol;
    const symbolNames = new Set<string>();
    for (const s of allSymbols) {
      symbolNames.add(s.name);
      if (s.name.includes('.')) {
        symbolNames.add(this.getShortName(s.name));
      }
    }
    const shortName = this.getShortName(name);
    const callees = symbol.callees.filter((c) => symbolNames.has(c) && c !== name && c !== shortName);
    return [...new Set(callees)];
  }

  private extractMethodSymbol(method: AnyNode, className: string, filePath: string): ExtractedSymbol {
    const signature = this.buildSignature(method);
    const callees = this.findCalledIdentifiers(method);

    return {
      name: `${className}.${method.getName()}`,
      kind: 'method',
      file: filePath,
      startLine: method.getStartLineNumber(),
      endLine: method.getEndLineNumber(),
      signature,
      callers: [],
      callees,
      docComment: method.getJsDocs().map((d: AnyNode) => d.getText()).join('\n') || undefined,
    };
  }

  private extractFunctionSymbol(
    func: AnyNode,
    filePath: string,
    bindingName?: string,
    documentationNode: AnyNode = func,
  ): ExtractedSymbol {
    const signature = this.buildSignature(func);
    const callees = this.findCalledIdentifiers(func);

    return {
      name: bindingName ?? func.getName(),
      kind: 'function',
      file: filePath,
      startLine: func.getStartLineNumber(),
      endLine: func.getEndLineNumber(),
      signature,
      callers: [],
      callees,
      docComment: documentationNode.getJsDocs().map((d: AnyNode) => d.getText()).join('\n') || undefined,
    };
  }

  private buildSignature(node: AnyNode): string | undefined {
    try {
      const params = node.getParameters().map((p: AnyNode) => {
        const paramType = p.getType();
        return `${p.getName()}: ${paramType.getText()}`;
      });
      const returnType = node.getReturnType().getText();
      return `(${params.join(', ')}): ${returnType}`;
    } catch {
      return undefined;
    }
  }

  private findCalledIdentifiers(node: AnyNode): string[] {
    try {
      const calls = node.getDescendants().filter((descendant: AnyNode) => descendant.getKindName() === 'CallExpression');
      const names: string[] = calls.map((call: AnyNode) => {
        const expression = call.getExpression().getText() as string;
        return expression.split('.').pop() ?? expression;
      });
      return [...new Set(names)];
    } catch {
      return [];
    }
  }
}
