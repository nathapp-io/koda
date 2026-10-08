import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { sourceFiles } from './source-files';

describe('sourceFiles', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'koda-source-files-'));
    mkdirSync(join(root, 'feature'));
    mkdirSync(join(root, 'generated', 'prisma'), { recursive: true });
    writeFileSync(join(root, 'feature', 'service.ts'), '');
    writeFileSync(join(root, 'feature', 'service.spec.ts'), '');
    writeFileSync(join(root, 'generated', 'prisma', 'client.ts'), '');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists non-spec TypeScript files and skips generated code', () => {
    expect(sourceFiles(root).map((file) => relative(root, file))).toEqual([join('feature', 'service.ts')]);
  });
});
