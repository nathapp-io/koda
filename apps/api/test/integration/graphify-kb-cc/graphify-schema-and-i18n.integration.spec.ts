/**
 * graphify-kb-cc: Schema, DTO & i18n Extension tests
 *
 * Covers:
 *   AC1  — Project.graphifyEnabled defaults to false in the Prisma schema
 *   AC8  — en/rag.json has non-empty graphifyDisabled key
 *   AC9  — zh/rag.json has non-empty graphifyDisabled key
 *   AC10 — en/rag.json has non-empty graphifyImportSuccess key
 *   AC11 — zh/rag.json has non-empty graphifyImportSuccess key
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const apiRoot = join(__dirname, '../../..');
const schemaPath = join(apiRoot, 'prisma/schema.prisma');
const enRagPath = join(apiRoot, 'src/i18n/en/rag.json');
const zhRagPath = join(apiRoot, 'src/i18n/zh/rag.json');

describe('Prisma schema — Project model graphify fields (AC1)', () => {
  let schemaContent: string;

  beforeAll(() => {
    schemaContent = readFileSync(schemaPath, 'utf-8');
  });

  it('defines graphifyEnabled as a Boolean field with @default(false) on the Project model', () => {
    // Expect a line like: graphifyEnabled Boolean @default(false)
    expect(schemaContent).toMatch(/graphifyEnabled\s+Boolean\s+@default\(false\)/);
  });

  it('defines graphifyLastImportedAt as an optional DateTime field on the Project model', () => {
    // Expect a line like: graphifyLastImportedAt DateTime?
    expect(schemaContent).toMatch(/graphifyLastImportedAt\s+DateTime\?/);
  });
});

describe('i18n — en/rag.json graphify keys (AC8, AC10)', () => {
  let enRag: Record<string, string>;

  beforeAll(() => {
    enRag = JSON.parse(readFileSync(enRagPath, 'utf-8')) as Record<string, string>;
  });

  // AC8
  it('has a non-empty string value for key "graphifyDisabled"', () => {
    expect(typeof enRag['graphifyDisabled']).toBe('string');
    expect((enRag['graphifyDisabled'] as string).length).toBeGreaterThan(0);
  });

  // AC10
  it('has a non-empty string value for key "graphifyImportSuccess"', () => {
    expect(typeof enRag['graphifyImportSuccess']).toBe('string');
    expect((enRag['graphifyImportSuccess'] as string).length).toBeGreaterThan(0);
  });
});

describe('i18n — zh/rag.json graphify keys (AC9, AC11)', () => {
  let zhRag: Record<string, string>;

  beforeAll(() => {
    zhRag = JSON.parse(readFileSync(zhRagPath, 'utf-8')) as Record<string, string>;
  });

  // AC9
  it('has a non-empty string value for key "graphifyDisabled"', () => {
    expect(typeof zhRag['graphifyDisabled']).toBe('string');
    expect((zhRag['graphifyDisabled'] as string).length).toBeGreaterThan(0);
  });

  // AC11
  it('has a non-empty string value for key "graphifyImportSuccess"', () => {
    expect(typeof zhRag['graphifyImportSuccess']).toBe('string');
    expect((zhRag['graphifyImportSuccess'] as string).length).toBeGreaterThan(0);
  });
});
