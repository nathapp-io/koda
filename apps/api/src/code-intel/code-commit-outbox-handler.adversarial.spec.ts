import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

// NestJS stores @Inject() metadata under this key on the class
const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';

describe('Adversarial Review Findings — code-commit-outbox-handler.ts', () => {
  const handlerFilePath = path.resolve(__dirname, 'code-commit-outbox-handler.ts');
  let handlerSource: string;

  beforeAll(() => {
    handlerSource = fs.readFileSync(handlerFilePath, 'utf-8');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bug 1: Inject decorator is imported but never used.
  //
  // Spec-correct behavior:
  //   @Inject(ConfigService) must be applied on the optional configService
  //   constructor parameter. Without it, NestJS cannot properly resolve
  //   forward-references when @Optional() is used — the DI container relies
  //   on SELF_DECLARED_DEPS_METADATA to identify custom injection tokens.
  // ──────────────────────────────────────────────────────────────────────────
  describe('Bug 1: @Inject() decorator usage', () => {
    it('should set self-declared dependency metadata on the ConfigService constructor parameter', () => {
      // Import the class so decorators are evaluated and metadata is available
      const { CodeCommitOutboxHandler } = require('./code-commit-outbox-handler');

      const declaredDeps = Reflect.getMetadata(
        SELF_DECLARED_DEPS_METADATA,
        CodeCommitOutboxHandler,
      );

      // Without @Inject(), this metadata is undefined — no custom injection
      // tokens have been registered on any constructor parameter.
      expect(declaredDeps).toBeDefined();

      // The optional ConfigService is the third constructor parameter (index 2).
      const configServiceEntry = (declaredDeps as Array<{ index: number; param: unknown }>).find(
        (d) => d.index === 2,
      );

      expect(configServiceEntry).toBeDefined();
      expect(configServiceEntry!.param).toBeDefined();
    });

    it('should use @Inject() decorator in the constructor — not just import it', () => {
      // Match @Inject( as a decorator application, excluding the import-line occurrence
      const decoratorMatches = handlerSource.match(/@Inject\(/g) || [];
      expect(decoratorMatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bug 2: VcsProviderConfig is imported but never used.
  //
  // Spec-correct behavior:
  //   VcsProviderConfig must appear as a type annotation beyond the import
  //   line. The natural usage site is the config object literal passed to
  //   createVcsProvider(), which should be explicitly typed so maintainers
  //   can see the full shape without navigating to the factory.
  // ──────────────────────────────────────────────────────────────────────────
  describe('Bug 2: VcsProviderConfig type usage', () => {
    it('should reference VcsProviderConfig beyond the import declaration', () => {
      const lines = handlerSource.split('\n');
      const nonImportLines = lines
        .filter((l) => !l.trimStart().startsWith('import '))
        .join('\n');

      const usageCount = (nonImportLines.match(/VcsProviderConfig/g) || []).length;
      expect(usageCount).toBeGreaterThan(0);
    });
  });
});
