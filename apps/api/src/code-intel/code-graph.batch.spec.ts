import { CodeGraphService } from './code-graph.service';

describe('CodeGraphService.extractBatch()', () => {
  let service: CodeGraphService;

  // The synchronous lazy loader uses the CommonJS export. Wrap it before the service caches it.
  const morph = require('ts-morph') as { Project: typeof import('ts-morph').Project };
  const RealProject = morph.Project;
  let constructions = 0;
  beforeAll(() => {
    morph.Project = class extends RealProject {
      constructor(...args: ConstructorParameters<typeof RealProject>) {
        super(...args);
        constructions++;
      }
    };
  });

  afterAll(() => {
    morph.Project = RealProject;
  });

  beforeEach(() => {
    constructions = 0;
    service = new CodeGraphService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-1: accepts a decorated constructor parameter in parseSourceFile', () => {
    const content = "declare function Inject(_t: string): ParameterDecorator;\nclass Svc { constructor(@Inject('X') private readonly x: string) {} }";
    expect(service.parseSourceFile('src/svc.ts', content).path).toBe('src/svc.ts');
  });

  it('AC-2: extracts decorated class and method symbols', () => {
    const content = "declare function Inject(_t: string): ParameterDecorator;\nclass Svc { constructor(@Inject('X') private readonly x: string) {} run(): number { return 1; } }";
    const result = service.extractBatch([{ path: 'src/svc.ts', content }]);
    expect(result).toHaveLength(1);
    expect('symbols' in result[0] && result[0].symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Svc', kind: 'class' }),
      expect.objectContaining({ name: 'Svc.run', kind: 'method' }),
    ]));
  });

  it("AC-3: rejects syntax errors with the Parse error prefix", () => {
    const result = service.extractBatch([{ path: 'src/broken.ts', content: 'export function broken( {' }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: 'src/broken.ts' });
    expect('error' in result[0] && result[0].error).toMatch(/^Parse error: .*'}' expected/);
  });

  it('AC-4: does not reject semantic type errors', () => {
    const content = "export const n: number = 'x';\nexport function f(a: number): number { return a; }";
    const result = service.extractBatch([{ path: 'src/typed.ts', content }]);
    expect('symbols' in result[0] && result[0].symbols.map((symbol) => symbol.name)).toContain('f');
  });

  it('AC-5: keeps ordered results and continues after a syntax failure', () => {
    const result = service.extractBatch([
      { path: 'src/a.ts', content: 'export function a() {}' },
      { path: 'src/b.ts', content: 'export function broken( {' },
      { path: 'src/c.ts', content: 'export function c() {}' },
    ]);
    expect(result.map(({ path }) => path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect('symbols' in result[0] && result[0].symbols.map(({ name }) => name)).toEqual(['a']);
    expect('error' in result[1]).toBe(true);
    expect('symbols' in result[2] && result[2].symbols.map(({ name }) => name)).toEqual(['c']);
  });

  it('AC-6: isolates files from imports in the same batch', () => {
    const b = "import { Foo } from './a';\nexport function use(f: Foo): void {}";
    const batch = service.extractBatch([
      { path: 'src/a.ts', content: 'export interface Foo { id: string }' },
      { path: 'src/b.ts', content: b },
    ]);
    const alone = service.extractBatch([{ path: 'src/b.ts', content: b }]);
    const findUse = (result: typeof batch) => {
      const file = result.find((item) => item.path === 'src/b.ts');
      expect(file).toBeDefined();
      if (!file || !('symbols' in file)) throw new Error('src/b.ts did not produce symbols');
      const symbol = file.symbols.find((candidate) => candidate.name === 'use');
      expect(symbol).toBeDefined();
      if (!symbol) throw new Error('use symbol was not extracted');
      return symbol;
    };
    const batchUse = findUse(batch);
    const standaloneUse = findUse(alone);
    expect(batchUse.signature).toEqual(standaloneUse.signature);
  });

  it('AC-7: matches standalone extraction across supported symbol kinds', () => {
    const path = 'src/all.ts';
    const content = 'class C { method(x: number): string { return String(x); } }\nfunction f() {}\ninterface I { id: string }\nenum E { A }';
    const result = service.extractBatch([{ path, content }]);
    expect('symbols' in result[0] && result[0].symbols).toEqual(service.extractSymbols(service.parseSourceFile(path, content)));
  });

  it('AC-8: creates one real Project for all files in a batch', () => {
    service.extractBatch([
      { path: 'src/a.ts', content: 'function a() {}' },
      { path: 'src/b.ts', content: 'function b() {}' },
      { path: 'src/c.ts', content: 'function c() {}' },
    ]);
    expect(constructions).toBe(1);
  });

  it('AC-9: creates a fresh Project for each batch call', () => {
    service.extractBatch([{ path: 'src/a.ts', content: 'function a() {}' }]);
    service.extractBatch([{ path: 'src/b.ts', content: 'function b() {}' }]);
    expect(constructions).toBe(2);
  });

  it('extracts for-loop callable initializers through both single-file and batch paths', () => {
    const path = 'src/for-callable.ts';
    const content = 'for (const loopFn = (): void => {}; false;) {}';
    const single = service.extractSymbols(service.parseSourceFile(path, content));
    const batch = service.extractBatch([{ path, content }]);
    expect(batch).toHaveLength(1);
    if (!('symbols' in batch[0])) throw new Error('for-callable.ts failed extraction');
    expect(single).toContainEqual(expect.objectContaining({ name: 'loopFn', kind: 'function', signature: '(): void', docComment: undefined }));
    expect(batch[0].symbols).toEqual(single);
  });

  it('AC-9/10/11/12: extracts and resolves callable variables equally in single-file and batch paths', () => {
    const path = 'src/callables.ts';
    const content = `function helper(value: string): string { return value; }\n/** callable docs */\nconst arrow = (value: string): string => helper(value);\nconst expression = function (value: string): string { return helper(value); };\nconst undocumented = (): void => {};`;
    const single = service.extractSymbols(service.parseSourceFile(path, content));
    const batch = service.extractBatch([{ path, content }]);
    expect(batch).toHaveLength(1);
    if (!('symbols' in batch[0])) throw new Error('callables.ts failed extraction');
    expect(batch[0].symbols).toEqual(single);
    for (const symbols of [single, batch[0].symbols]) {
      expect(symbols.find(({ name }) => name === 'arrow')).toMatchObject({ name: 'arrow', signature: '(value: string): string', docComment: expect.stringContaining('callable docs'), callees: ['helper'] });
      expect(symbols.find(({ name }) => name === 'expression')).toMatchObject({ name: 'expression', signature: '(value: string): string', callees: ['helper'] });
      expect(symbols.find(({ name }) => name === 'undocumented')).toMatchObject({ name: 'undocumented', signature: '(): void' });
      expect(symbols.find(({ name }) => name === 'undocumented')?.docComment).toBeUndefined();
      const resolved = symbols.map((symbol, index) => ({ ...symbol, symbolId: `id-${index}` }));
      service.resolveRelationships(resolved);
      expect(resolved.find(({ name }) => name === 'arrow')?.callees).toEqual(['id-0']);
      expect(resolved.find(({ name }) => name === 'expression')?.callees).toEqual(['id-0']);
    }
  });

  it("AC-11: stringifies non-Error failures", () => {
    vi.spyOn(service, 'extractSymbols').mockImplementationOnce(() => { throw 'boom'; });
    expect(service.extractBatch([{ path: 'src/a.ts', content: 'export function a() {}' }])).toEqual([
      { path: 'src/a.ts', error: 'boom' },
    ]);
  });

  it('AC-12: overwrites a repeated path after removing its previous source file', () => {
    const result = service.extractBatch([
      { path: 'src/dup.ts', content: 'function one() {}' },
      { path: 'src/dup.ts', content: 'function two() {}' },
    ]);
    expect(result.map((item) => 'symbols' in item && item.symbols.map(({ name }) => name))).toEqual([['one'], ['two']]);
  });

  it('AC-13: returns an empty array without processing files', () => {
    expect(service.extractBatch([])).toEqual([]);
  });
});
