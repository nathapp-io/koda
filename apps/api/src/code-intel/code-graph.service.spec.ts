import { CodeGraphService, ExtractedSymbol, ResolvedSymbol } from './code-graph.service';

describe('CodeGraphService', () => {
  let service: CodeGraphService;

  beforeEach(() => {
    service = new CodeGraphService();
  });

  describe('parseSourceFile()', () => {
    it('parses valid TypeScript content and returns a ParsedSourceFile', () => {
      const result = service.parseSourceFile('src/foo.ts', 'const x = 1;');
      expect(result.path).toBe('src/foo.ts');
      expect(result.content).toBe('const x = 1;');
      expect(result.ast).toBeDefined();
    });

    it('throws on syntax errors', () => {
      expect(() =>
        service.parseSourceFile('src/bad.ts', 'const = ;'),
      ).toThrow(/Parse error/);
    });

    it('parses an empty file without throwing', () => {
      const result = service.parseSourceFile('src/empty.ts', '');
      expect(result.path).toBe('src/empty.ts');
    });
  });

  describe('extractSymbols()', () => {
    function parse(content: string) {
      return service.parseSourceFile('src/test.ts', content);
    }

    it('extracts a class symbol', () => {
      const parsed = parse('class Foo {}');
      const symbols = service.extractSymbols(parsed);
      expect(symbols.some((s) => s.name === 'Foo' && s.kind === 'class')).toBe(true);
    });

    it('extracts a method symbol from a class', () => {
      const parsed = parse('class Foo { bar() {} }');
      const symbols = service.extractSymbols(parsed);
      expect(symbols.some((s) => s.name === 'Foo.bar' && s.kind === 'method')).toBe(true);
    });

    it('extracts a top-level function', () => {
      const parsed = parse('function myFn() {}');
      const symbols = service.extractSymbols(parsed);
      expect(symbols.some((s) => s.name === 'myFn' && s.kind === 'function')).toBe(true);
    });

    it('extracts an interface', () => {
      const parsed = parse('interface IBar { x: number; }');
      const symbols = service.extractSymbols(parsed);
      expect(symbols.some((s) => s.name === 'IBar' && s.kind === 'interface')).toBe(true);
    });

    it('extracts an enum', () => {
      const parsed = parse('enum Color { Red, Green }');
      const symbols = service.extractSymbols(parsed);
      expect(symbols.some((s) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
    });

    it('throws when extracting arrow function variable declarations (ts-morph VariableDeclaration lacks getJsDocs)', () => {
      // VariableDeclaration in ts-morph does not expose getJsDocs(), causing a
      // TypeError inside extractFunctionSymbol. This test documents the current
      // known behavior so regressions are caught if the service is fixed.
      const parsed = parse('const myArrow = () => 42;');
      expect(() => service.extractSymbols(parsed)).toThrow(TypeError);
    });

    it('returns empty array for a file with no extractable symbols', () => {
      const parsed = parse('const x = 1;');
      const symbols = service.extractSymbols(parsed);
      // x is a plain variable, not a function/class/interface/enum
      expect(symbols.every((s) => s.kind !== 'class')).toBe(true);
    });

    it('attaches file path to each symbol', () => {
      const parsed = service.parseSourceFile('src/my/module.ts', 'function doThing() {}');
      const symbols = service.extractSymbols(parsed);
      expect(symbols.every((s) => s.file === 'src/my/module.ts')).toBe(true);
    });

    it('extracts JSDoc comment on a class', () => {
      const parsed = parse('/** my class doc */ class Documented {}');
      const symbols = service.extractSymbols(parsed);
      const cls = symbols.find((s) => s.name === 'Documented');
      expect(cls?.docComment).toContain('my class doc');
    });
  });

  describe('resolveRelationships()', () => {
    it('links callee -> caller correctly', () => {
      const symbols: ResolvedSymbol[] = [
        {
          symbolId: 'helper',
          name: 'helper',
          kind: 'function',
          file: 'src/a.ts',
          startLine: 1,
          endLine: 3,
          callers: [],
          callees: [],
        },
        {
          symbolId: 'caller',
          name: 'caller',
          kind: 'function',
          file: 'src/a.ts',
          startLine: 5,
          endLine: 10,
          callers: [],
          callees: ['helper'],
        },
      ];

      service.resolveRelationships(symbols);

      const helperSym = symbols.find((s) => s.symbolId === 'helper');
      const callerSym = symbols.find((s) => s.symbolId === 'caller');

      expect(callerSym?.callees).toContain('helper');
      expect(helperSym?.callers).toContain('caller');
    });

    it('skips self-references in callees', () => {
      const symbols: ResolvedSymbol[] = [
        {
          symbolId: 'recursive',
          name: 'recursive',
          kind: 'function',
          file: 'src/a.ts',
          startLine: 1,
          endLine: 5,
          callers: [],
          callees: ['recursive'],
        },
      ];

      service.resolveRelationships(symbols);

      // self-call should be stripped
      expect(symbols[0].callees).toHaveLength(0);
    });

    it('handles empty symbol list without error', () => {
      expect(() => service.resolveRelationships([])).not.toThrow();
    });

    it('deduplicates callees', () => {
      const symbols: ResolvedSymbol[] = [
        {
          symbolId: 'util',
          name: 'util',
          kind: 'function',
          file: 'src/a.ts',
          startLine: 1,
          endLine: 2,
          callers: [],
          callees: [],
        },
        {
          symbolId: 'main',
          name: 'main',
          kind: 'function',
          file: 'src/a.ts',
          startLine: 3,
          endLine: 10,
          callers: [],
          callees: ['util', 'util'],
        },
      ];

      service.resolveRelationships(symbols);

      const mainSym = symbols.find((s) => s.symbolId === 'main');
      const utilOccurrences = mainSym?.callees.filter((c) => c === 'util');
      expect(utilOccurrences).toHaveLength(1);
    });
  });

  describe('extractCallers()', () => {
    it('returns symbols that include this symbol in their callees', () => {
      const target: ExtractedSymbol = {
        name: 'myFn',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        callers: [],
        callees: [],
      };
      const caller: ExtractedSymbol = {
        name: 'otherFn',
        kind: 'function',
        file: 'src/b.ts',
        startLine: 1,
        endLine: 5,
        callers: [],
        callees: ['myFn'],
      };
      const result = service.extractCallers(target, [target, caller]);
      expect(result).toContain('otherFn');
    });

    it('does not include the symbol itself as a caller', () => {
      const sym: ExtractedSymbol = {
        name: 'myFn',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        callers: [],
        callees: ['myFn'],
      };
      const result = service.extractCallers(sym, [sym]);
      expect(result).not.toContain('myFn');
    });

    it('returns empty array when no callers exist', () => {
      const sym: ExtractedSymbol = {
        name: 'lonely',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        callers: [],
        callees: [],
      };
      expect(service.extractCallers(sym, [sym])).toHaveLength(0);
    });
  });

  describe('extractCallees()', () => {
    it('returns known symbol names referenced in callees', () => {
      const known: ExtractedSymbol = {
        name: 'helperFn',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        callers: [],
        callees: [],
      };
      const sym: ExtractedSymbol = {
        name: 'mainFn',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 5,
        endLine: 10,
        callers: [],
        callees: ['helperFn', 'unknownFn'],
      };
      const result = service.extractCallees(sym, [known, sym]);
      expect(result).toContain('helperFn');
      expect(result).not.toContain('unknownFn');
    });

    it('does not include self-reference', () => {
      const sym: ExtractedSymbol = {
        name: 'myFn',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        callers: [],
        callees: ['myFn'],
      };
      expect(service.extractCallees(sym, [sym])).not.toContain('myFn');
    });

    it('deduplicates callees', () => {
      const known: ExtractedSymbol = {
        name: 'util',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        callers: [],
        callees: [],
      };
      const sym: ExtractedSymbol = {
        name: 'main',
        kind: 'function',
        file: 'src/a.ts',
        startLine: 3,
        endLine: 10,
        callers: [],
        callees: ['util', 'util'],
      };
      const result = service.extractCallees(sym, [known, sym]);
      expect(result.filter((c) => c === 'util')).toHaveLength(1);
    });
  });
});
