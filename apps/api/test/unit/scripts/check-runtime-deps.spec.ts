/**
 * The production image installs runtime deps with its own `bun install --production`,
 * which resolves `~` ranges fresh. When a package pins a sibling exactly (nestjs-notify
 * 1.3.1 depends on nestjs-tenant "1.3.1") and koda pins another version, a second copy
 * is nested. Nest DI tokens are classes, so the API cannot boot (#437). The build
 * guard must find every DI-relevant package installed at more than one version.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDuplicateVersions } from '../../../scripts/check-runtime-deps';

describe('findDuplicateVersions', () => {
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

    expect(findDuplicateVersions(dir)).toEqual([
      { name: '@nathapp/nestjs-tenant', versions: ['1.3.0', '1.3.1'] },
    ]);
  });

  it('reports two versions in the Bun isolated store', () => {
    pkg('.bun/@nathapp+nestjs-tenant@1.3.0+aa/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.0');
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+bb/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');

    expect(findDuplicateVersions(dir)).toEqual([
      { name: '@nathapp/nestjs-tenant', versions: ['1.3.0', '1.3.1'] },
    ]);
  });

  it('accepts one version installed under several peer hashes', () => {
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+aa/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+bb/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');

    expect(findDuplicateVersions(dir)).toEqual([]);
  });

  it('checks @nestjs packages too', () => {
    pkg('@nestjs/core', '@nestjs/core', '12.4.2');
    pkg('@nathapp/nestjs-app/node_modules/@nestjs/core', '@nestjs/core', '12.2.0');

    expect(findDuplicateVersions(dir)).toEqual([{ name: '@nestjs/core', versions: ['12.2.0', '12.4.2'] }]);
  });

  it('ignores duplicates outside the DI scopes', () => {
    pkg('glob', 'glob', '14.0.4');
    pkg('rimraf/node_modules/glob', 'glob', '10.4.5');

    expect(findDuplicateVersions(dir)).toEqual([]);
  });

  it('ignores package.json files inside a package that are not package roots', () => {
    pkg('@nathapp/nestjs-notify', '@nathapp/nestjs-notify', '1.3.1');
    pkg('@nathapp/nestjs-notify/dist/esm', '@nathapp/nestjs-notify', '0.0.0');

    expect(findDuplicateVersions(dir)).toEqual([]);
  });

  it('does not follow symlinked package directories', () => {
    pkg('.bun/@nathapp+nestjs-tenant@1.3.1+aa/node_modules/@nathapp/nestjs-tenant', '@nathapp/nestjs-tenant', '1.3.1');
    fs.mkdirSync(path.join(dir, '@nathapp'), { recursive: true });
    fs.symlinkSync(
      path.join(dir, '.bun/@nathapp+nestjs-tenant@1.3.1+aa/node_modules/@nathapp/nestjs-tenant'),
      path.join(dir, '@nathapp/nestjs-tenant'),
    );

    expect(findDuplicateVersions(dir)).toEqual([]);
  });
});
