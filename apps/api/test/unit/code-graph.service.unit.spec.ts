import { CodeGraphService, ExtractedSymbol } from '../../src/code-intel/code-graph.service';

describe('CodeGraphService', () => {
  let service: CodeGraphService;

  beforeEach(() => {
    service = new CodeGraphService();
  });

  function makeSymbol(overrides: Partial<ExtractedSymbol> & { name: string }): ExtractedSymbol {
    return {
      kind: 'function',
      file: 'src/test.ts',
      startLine: 1,
      endLine: 1,
      signature: undefined,
      callers: [],
      callees: [],
      docComment: undefined,
      ...overrides,
    };
  }

  describe('BUG-2: extractCallers should filter raw callees before computing callers', () => {
    it('should match qualified symbol names against unqualified callee identifiers', () => {
      const allSymbols = [
        makeSymbol({
          name: 'UserService.authenticate',
          kind: 'method',
          file: 'src/auth.ts',
          startLine: 5,
          endLine: 7,
          signature: '(token: string): Promise<User>',
        }),
        makeSymbol({
          name: 'login',
          file: 'src/login.ts',
          startLine: 1,
          endLine: 10,
          callees: ['authenticate', 'validateCredentials', 'generateToken'],
        }),
        makeSymbol({
          name: 'validateCredentials',
          file: 'src/login.ts',
          startLine: 3,
          endLine: 5,
        }),
      ];

      const callers = service.extractCallers(allSymbols[0], allSymbols);
      expect(callers).toContain('login');
    });

    it('should not treat every raw identifier as a caller — only other extracted symbol names', () => {
      const allSymbols = [
        makeSymbol({
          name: 'processRequest',
          file: 'src/handler.ts',
          startLine: 1,
          endLine: 10,
          callees: ['authenticate', 'console', 'log', 'validator'],
        }),
        makeSymbol({
          name: 'authenticate',
          file: 'src/auth.ts',
          startLine: 1,
          endLine: 5,
        }),
        makeSymbol({
          name: 'validator',
          file: 'src/validate.ts',
          startLine: 1,
          endLine: 3,
        }),
      ];

      const callersOfAuthenticate = service.extractCallers(allSymbols[1], allSymbols);
      expect(callersOfAuthenticate).toEqual(['processRequest']);

      const callersOfValidator = service.extractCallers(allSymbols[2], allSymbols);
      expect(callersOfValidator).toEqual(['processRequest']);
    });

    it('should not return false callers from duplicate callee entries', () => {
      const allSymbols = [
        makeSymbol({
          name: 'runPipeline',
          file: 'src/pipeline.ts',
          startLine: 1,
          endLine: 20,
          callees: ['validate', 'transform', 'validate', 'publish'],
        }),
        makeSymbol({
          name: 'validate',
          file: 'src/validate.ts',
          startLine: 1,
          endLine: 5,
        }),
        makeSymbol({
          name: 'transform',
          file: 'src/transform.ts',
          startLine: 1,
          endLine: 8,
        }),
      ];

      const callersOfValidate = service.extractCallers(allSymbols[1], allSymbols);
      expect(callersOfValidate).toEqual(['runPipeline']);

      const callersOfRunPipeline = service.extractCallers(allSymbols[0], allSymbols);
      expect(callersOfRunPipeline).toEqual([]);
    });
  });
});
