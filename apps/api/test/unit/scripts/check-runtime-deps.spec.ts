/**
 * The production image installs runtime deps with its own `bun install --production`,
 * which resolves `~` ranges fresh. When a package pins a sibling exactly (nestjs-notify
 * 1.3.1 depends on nestjs-tenant "1.3.1") and koda pins another version, a second copy
 * is nested. Nest DI tokens are classes, so the API cannot boot (#437). The build
 * guard must find every DI-relevant package installed more than once: Nest tells
 * providers apart by class object, so even two copies of the same version break DI.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDuplicatePackages } from '../../../scripts/check-runtime-deps';

describe('findDuplicatePackages', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-deps-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pkg = (rel: string, name: string, version: string) => {
    const pkgDir = path.join(dir, rel);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  };

  it('reports a package nested at a second version (hoisted layout)', () => {
    pkg('@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.0');
    pkg('@nathapp/nestjs-notify', '@nathapp/nestjs-notify', '1.3.1');
    pkg('@nathapp/nestjs-notify/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');

    expect(findDuplicatePackages(dir)).toEqual([
      {
        name: '@nathapp/nestjs-tenant',
        copies: [
          { path: '@nathapp/nestjs-notify/node_modules/@nathapp/nestjs-tenant', version: '1.3.1' },
          { path: '@nathapp/nestjs-tenant', version: '1.3.0' },
        ],
      },
    ]);
  });

  it('reports two copies of the same version (hoisted layout)', () => {
    pkg('@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');
    pkg('@nathapp/nestjs-notify/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');

    expect(findDuplicatePackages(dir).map((dup) => dup.name)).toEqual(['@nathapp/nestjs-tenant']);
  });

  it('reports two versions in the Bun isolated store', () => {
    pkg('.bun/@nathapp+nestjs-tenant@1.3.0+aa/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.0');
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+bb/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');

    expect(findDuplicatePackages(dir).map((dup) => dup.name)).toEqual(['@nathapp/nestjs-tenant']);
  });

  it('reports one version installed under two peer hashes (two copies, two classes)', () => {
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+aa/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+bb/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');

    expect(findDuplicatePackages(dir).map((dup) => dup.name)).toEqual(['@nathapp/nestjs-tenant']);
  });

  it('checks unscoped nestjs-* packages (nestjs-i18n provides DI tokens)', () => {
    pkg('nestjs-i18n', 'nestjs-i18n', '10.8.5');
    pkg('@nathapp/nestjs-common/node_modules/nestjs-i18n', 'nestjs-i18n', '11.0.0');

    expect(findDuplicatePackages(dir).map((dup) => dup.name)).toEqual(['nestjs-i18n']);
  });

  it('names the file when a package.json cannot be parsed', () => {
    fs.mkdirSync(path.join(dir, '@nathapp/broken'), { recursive: true });
    fs.writeFileSync(path.join(dir, '@nathapp/broken/package.json'), '{bad');

    expect(() => findDuplicatePackages(dir)).toThrow(/cannot parse .*@nathapp\/broken\/package\.json/);
  });

  it('skips a package.json whose name or version is not a string', () => {
    fs.mkdirSync(path.join(dir, 'odd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'odd/package.json'), JSON.stringify({ name: 123, version: '1.0.0' }));

    expect(findDuplicatePackages(dir)).toEqual([]);
  });

  it('checks @nestjs packages too', () => {
    pkg('@nestjs/core', '@nestjs/core', '12.4.2');
    pkg('@nathapp/nestjs-app/node_modules/@nestjs/core', '@nestjs/core', '12.2.0');

    expect(findDuplicatePackages(dir).map((dup) => dup.name)).toEqual(['@nestjs/core']);
  });

  it('ignores duplicates outside the DI scopes', () => {
    pkg('glob', 'glob', '14.0.4');
    pkg('rimraf/node_modules/glob', 'glob', '10.4.5');

    expect(findDuplicatePackages(dir)).toEqual([]);
  });

  it('ignores package.json files inside a package that are not package roots', () => {
    pkg('@nathapp/nestjs-notify', '@nathapp/nestjs-notify', '1.3.1');
    pkg('@nathapp/nestjs-notify/dist/esm', '@nathapp/nestjs-notify', '0.0.0');

    expect(findDuplicatePackages(dir)).toEqual([]);
  });

  it('does not follow symlinked package directories', () => {
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+aa/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');
    fs.mkdirSync(path.join(dir, '@nathapp'), { recursive: true });
    fs.symlinkSync(
      path.join(dir, '.bun/@nathapp+nestjs-tenant@1.3.1+aa/node_modules/@nathapp/nestjs-tenant'),
      path.join(dir, '@nathapp/nestjs-tenant'),
    );

    expect(findDuplicatePackages(dir)).toEqual([]);
  });
});
