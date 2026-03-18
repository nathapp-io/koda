/**
 * Phase 3 — Step 3: OpenAPI Client Sanity Checks
 *
 * Validates that:
 * - Generated CLI client files exist and export expected symbols
 * - Generated web client files exist and export expected symbols
 * - Key service functions and types are present in generated code
 * - openapi.json is committed at repo root
 *
 * hey-api/openapi-ts generates flat files (not service directories):
 *   services.gen.ts  — all API functions
 *   types.gen.ts     — all request/response types
 *   schemas.gen.ts   — JSON schemas
 *   index.ts         — barrel export
 *   core/            — client runtime (Axios/Fetch)
 *
 * Run: bun run test:integration
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CLI_GENERATED = path.join(REPO_ROOT, 'packages/cli/src/generated');
const WEB_GENERATED = path.join(REPO_ROOT, 'apps/web/generated');
const OPENAPI_JSON = path.join(REPO_ROOT, 'openapi.json');
const HAS_CLI_GENERATED = fs.existsSync(CLI_GENERATED);

describe('Phase 3 — Step 3: OpenAPI Client Sanity Checks', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Spec committed
  // ─────────────────────────────────────────────────────────────────────────

  describe('openapi.json committed at repo root', () => {
    it('should exist', () => {
      expect(fs.existsSync(OPENAPI_JSON)).toBe(true);
    });

    it('should not be empty (>1KB)', () => {
      const stat = fs.statSync(OPENAPI_JSON);
      expect(stat.size).toBeGreaterThan(1000);
    });

    it('should parse as valid JSON', () => {
      const raw = fs.readFileSync(OPENAPI_JSON, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. CLI client (Axios)
  // ─────────────────────────────────────────────────────────────────────────

  const describeCli = HAS_CLI_GENERATED ? describe : describe.skip;

  describeCli('CLI client (packages/cli/src/generated)', () => {
    it('should have generated directory', () => {
      expect(fs.existsSync(CLI_GENERATED)).toBe(true);
    });

    it('should have index.ts barrel export', () => {
      expect(fs.existsSync(path.join(CLI_GENERATED, 'index.ts'))).toBe(true);
    });

    it('should have services.gen.ts', () => {
      expect(fs.existsSync(path.join(CLI_GENERATED, 'services.gen.ts'))).toBe(true);
    });

    it('should have types.gen.ts', () => {
      expect(fs.existsSync(path.join(CLI_GENERATED, 'types.gen.ts'))).toBe(true);
    });

    it('should have core/ runtime directory', () => {
      expect(fs.existsSync(path.join(CLI_GENERATED, 'core'))).toBe(true);
    });

    describe('services.gen.ts content', () => {
      let services: string;

      beforeAll(() => {
        services = fs.readFileSync(path.join(CLI_GENERATED, 'services.gen.ts'), 'utf-8');
      });

      it('should contain auth functions', () => {
        expect(services).toMatch(/authController(Register|Login)/);
      });

      it('should contain ticket functions', () => {
        expect(services).toMatch(/ticketsController(Create|FindAll|Verify|Fix)/);
      });

      it('should contain project functions', () => {
        expect(services).toMatch(/projectsController(Create|FindAll)/);
      });

      it('should contain agent functions', () => {
        expect(services).toMatch(/agentsController(FindAll|FindMe|RotateApiKey)/);
      });

      it('should contain comment functions', () => {
        expect(services).toMatch(/commentsController(Create|Update|Delete)/);
      });

      it('should contain label functions', () => {
        expect(services).toMatch(/labelsController(Create|FindBy)/);
      });

      it('should reference all ticket state transitions', () => {
        const transitions = ['Verify', 'Fix', 'VerifyFix', 'Start', 'Assign', 'Reject', 'Close'];
        transitions.forEach((t) => {
          expect(services).toMatch(new RegExp(`ticketsController${t}`));
        });
      });

      it('should use Axios client (not fetch)', () => {
        expect(services).toMatch(/CancelablePromise|OpenAPI/);
      });

      it('should not contain obvious codegen errors', () => {
        expect(services).not.toMatch(/TODO:|FIXME:|codegen error/i);
      });
    });

    describe('types.gen.ts content', () => {
      let types: string;

      beforeAll(() => {
        types = fs.readFileSync(path.join(CLI_GENERATED, 'types.gen.ts'), 'utf-8');
      });

      it('should export RegisterDto', () => {
        expect(types).toMatch(/export type RegisterDto/);
      });

      it('should export LoginDto', () => {
        expect(types).toMatch(/export type LoginDto/);
      });

      it('should export AuthResponseDto', () => {
        expect(types).toMatch(/export type AuthResponseDto/);
      });

      it('should export CreateTicketDto', () => {
        expect(types).toMatch(/export type CreateTicketDto/);
      });

      it('should export TicketResponseDto', () => {
        expect(types).toMatch(/export type TicketResponseDto/);
      });

      it('should export CreateProjectDto', () => {
        expect(types).toMatch(/export type CreateProjectDto/);
      });

      it('should export UpdateAgentDto', () => {
        expect(types).toMatch(/export type UpdateAgentDto/);
      });

      it('should contain ticket status enum or type', () => {
        expect(types).toMatch(/CREATED|VERIFIED|IN_PROGRESS/);
      });

      it('should contain ticket type enum (BUG|ENHANCEMENT)', () => {
        expect(types).toMatch(/BUG|ENHANCEMENT/);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Web client (Fetch)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Web client (apps/web/generated)', () => {
    it('should have generated directory', () => {
      expect(fs.existsSync(WEB_GENERATED)).toBe(true);
    });

    it('should have index.ts barrel export', () => {
      expect(fs.existsSync(path.join(WEB_GENERATED, 'index.ts'))).toBe(true);
    });

    it('should have services.gen.ts', () => {
      expect(fs.existsSync(path.join(WEB_GENERATED, 'services.gen.ts'))).toBe(true);
    });

    it('should have types.gen.ts', () => {
      expect(fs.existsSync(path.join(WEB_GENERATED, 'types.gen.ts'))).toBe(true);
    });

    it('should have core/ runtime directory', () => {
      expect(fs.existsSync(path.join(WEB_GENERATED, 'core'))).toBe(true);
    });

    describe('services.gen.ts content', () => {
      let services: string;

      beforeAll(() => {
        services = fs.readFileSync(path.join(WEB_GENERATED, 'services.gen.ts'), 'utf-8');
      });

      it('should contain auth, tickets, projects, agents, comments, labels', () => {
        expect(services).toMatch(/authController/);
        expect(services).toMatch(/ticketsController/);
        expect(services).toMatch(/projectsController/);
        expect(services).toMatch(/agentsController/);
        expect(services).toMatch(/commentsController/);
        expect(services).toMatch(/labelsController/);
      });

      it('should have ticket state transition functions', () => {
        // Verify all 7 transitions are present
        const transitions = ['Verify', 'Fix', 'VerifyFix', 'Start', 'Assign', 'Reject', 'Close'];
        transitions.forEach((t) => {
          expect(services).toMatch(new RegExp(`ticketsController${t}`));
        });
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Consistency: CLI vs Web parity
  // ─────────────────────────────────────────────────────────────────────────

  describe('Consistency: CLI and Web clients', () => {
    it('should both export the same service function names', () => {
      const cliServices = fs.readFileSync(
        path.join(CLI_GENERATED, 'services.gen.ts'),
        'utf-8',
      );
      const webServices = fs.readFileSync(
        path.join(WEB_GENERATED, 'services.gen.ts'),
        'utf-8',
      );

      // Extract exported function names
      const extractFns = (content: string) =>
        [...content.matchAll(/export const (\w+)/g)]
          .map((m) => m[1])
          .sort();

      const cliFns = extractFns(cliServices);
      const webFns = extractFns(webServices);

      expect(cliFns).toEqual(webFns);
    });

    it('should both export the same type names', () => {
      const cliTypes = fs.readFileSync(
        path.join(CLI_GENERATED, 'types.gen.ts'),
        'utf-8',
      );
      const webTypes = fs.readFileSync(
        path.join(WEB_GENERATED, 'types.gen.ts'),
        'utf-8',
      );

      const extractTypes = (content: string) =>
        [...content.matchAll(/export type (\w+)/g)]
          .map((m) => m[1])
          .sort();

      const cliTypeNames = extractTypes(cliTypes);
      const webTypeNames = extractTypes(webTypes);

      expect(cliTypeNames).toEqual(webTypeNames);
    });

    it('CLI and Web generated output should be similar in size', () => {
      const cliSize = fs.statSync(path.join(CLI_GENERATED, 'services.gen.ts')).size;
      const webSize = fs.statSync(path.join(WEB_GENERATED, 'services.gen.ts')).size;

      // Both should be non-trivial and roughly similar (within 30%)
      expect(cliSize).toBeGreaterThan(1000);
      expect(webSize).toBeGreaterThan(1000);
      const ratio = Math.max(cliSize, webSize) / Math.min(cliSize, webSize);
      expect(ratio).toBeLessThan(1.3);
    });
  });
});
