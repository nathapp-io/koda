import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..', '..'); // repo root

function srcFiles() {
  const { execSync } = require('child_process');
  return execSync(`find ${join(root, 'apps/api/src')} -name "*.ts"`, { encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

describe('refactor-standard - Acceptance Tests', () => {
  test('AC-1: No imports from @nestjs/jwt or @nestjs/passport in apps/api/src', () => {
    for (const f of srcFiles()) {
      const c = readFileSync(f, 'utf8');
      expect(c).not.toMatch(/from\s+['"]@nestjs\/jwt['"]/);
      expect(c).not.toMatch(/from\s+['"]@nestjs\/passport['"]/);
    }
  });

  test('AC-8: @nestjs/jwt, @nestjs/passport, passport-jwt removed from apps/api/package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@nestjs/jwt']).toBeUndefined();
    expect(deps['@nestjs/passport']).toBeUndefined();
    expect(deps['passport-jwt']).toBeUndefined();
  });

  test('AC-35: @nathapp/nestjs-throttler present in apps/api/package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@nathapp/nestjs-throttler']).toBeDefined();
  });

  test('AC-40: No custom PrismaService if @nathapp/nestjs-prisma is used', () => {
    const prismaDir = join(root, 'apps/api/src/prisma');
    const hasPrismaDir = existsSync(prismaDir);
    // Either no custom prisma dir, or it only extends the nathapp base
    if (hasPrismaDir) {
      const { execSync } = require('child_process');
      const files = execSync(`find ${prismaDir} -name "*.ts"`, { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (const f of files) {
        const c = readFileSync(f, 'utf8');
        // Should not reimplement from scratch — must import from nathapp
        if (c.includes('class PrismaService')) {
          expect(c).toMatch(/@nathapp\/nestjs-prisma/);
        }
      }
    }
  });

  test('AC-50: api:export-spec script exists in root package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['api:export-spec']).toBeDefined();
  });
});
