import { Injectable, Logger } from '@nestjs/common';
import { Project, SourceFile } from 'ts-morph';
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

@Injectable()
export class CodeGraphService {
  private readonly logger = new Logger(CodeGraphService.name);

  parseSourceFile(path: string, content: string): ParsedSourceFile {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(path, content);
    return { path, content, ast: sourceFile };
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
          symbols.push(this.extractFunctionSymbol(varDecl, parsed.path));
        }
      }
    }

    return symbols;
  }

  extractCallers(symbol: ExtractedSymbol, allSymbols: ExtractedSymbol[]): string[] {
    const callers: string[] = [];
    for (const other of allSymbols) {
      if (other.name === symbol.name && other.file === symbol.file) continue;
      if (other.callees.includes(symbol.name)) {
        callers.push(other.name);
      }
    }
    return callers;
  }

  extractCallees(symbol: ExtractedSymbol, allSymbols: ExtractedSymbol[]): string[] {
    const { name } = symbol;
    const symbolNames = new Set(allSymbols.map((s) => s.name));
    const callees = symbol.callees.filter((c) => symbolNames.has(c) && c !== name);
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

  private extractFunctionSymbol(func: AnyNode, filePath: string): ExtractedSymbol {
    const signature = this.buildSignature(func);
    const callees = this.findCalledIdentifiers(func);

    return {
      name: func.getName(),
      kind: 'function',
      file: filePath,
      startLine: func.getStartLineNumber(),
      endLine: func.getEndLineNumber(),
      signature,
      callers: [],
      callees,
      docComment: func.getJsDocs().map((d: AnyNode) => d.getText()).join('\n') || undefined,
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
      const identifiers = node.getDescendantsOfKind(300);
      const names: string[] = identifiers.map((id: AnyNode) => id.getText() as string);
      return [...new Set(names)];
    } catch {
      return [];
    }
  }
}
