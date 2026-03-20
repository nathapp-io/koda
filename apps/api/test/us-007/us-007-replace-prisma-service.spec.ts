/**
 * US-007: Replace custom PrismaService with @nathapp/nestjs-prisma
 *
 * Acceptance Criteria:
 * AC1 — No duplicate PrismaService if nathapp's service covers it
 * AC2 — If custom extension needed, it extends (not reimplements) nathapp's base PrismaService
 * AC3 — apps/api/src/prisma/ directory deleted if fully replaced
 * AC4 — All feature modules import from the correct PrismaModule
 * AC5 — All existing Prisma-dependent tests still pass (import from @nathapp/nestjs-prisma)
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function srcExists(relPath: string): boolean {
  return fs.existsSync(path.join(SRC, relPath));
}

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// AC1 — No duplicate PrismaService
// ---------------------------------------------------------------------------

describe('AC1 — No duplicate PrismaService', () => {
  it('src/prisma/prisma.service.ts should not exist (nathapp covers lifecycle)', () => {
    expect(srcExists('prisma/prisma.service.ts')).toBe(false);
  });

  it('src/prisma/prisma.module.ts should not exist (nathapp covers module)', () => {
    expect(srcExists('prisma/prisma.module.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — If custom extension exists, it must extend nathapp base
// ---------------------------------------------------------------------------

describe('AC2 — Custom extension (if any) extends nathapp base PrismaService', () => {
  it('if src/prisma/prisma.service.ts exists, it must extend nathapp PrismaService', () => {
    if (!srcExists('prisma/prisma.service.ts')) {
      // File was deleted — AC3 covers this; no extension needed
      expect(true).toBe(true);
      return;
    }
    const source = readSrc('prisma/prisma.service.ts');
    // Must import from @nathapp/nestjs-prisma, not reimplement from scratch
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
    // Must extend PrismaService (i.e., not reimplement OnModuleInit/OnModuleDestroy itself)
    expect(source).toMatch(/extends\s+PrismaService/);
    // Must NOT reimport PrismaClient directly to reimplement lifecycle
    expect(source).not.toMatch(/implements\s+OnModuleInit/);
    expect(source).not.toMatch(/implements\s+OnModuleDestroy/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — apps/api/src/prisma/ directory deleted if fully replaced
// ---------------------------------------------------------------------------

describe('AC3 — src/prisma/ directory removed (no custom implementation remains)', () => {
  it('src/prisma/ directory should not exist', () => {
    const prismaDir = path.join(SRC, 'prisma');
    expect(fs.existsSync(prismaDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — app.module.ts imports PrismaModule from @nathapp/nestjs-prisma
// ---------------------------------------------------------------------------

describe('AC4 — app.module.ts uses @nathapp/nestjs-prisma PrismaModule', () => {
  it('src/app.module.ts exists', () => {
    expect(srcExists('app.module.ts')).toBe(true);
  });

  it('imports PrismaModule from @nathapp/nestjs-prisma', () => {
    const source = readSrc('app.module.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from the old custom ./prisma/prisma.module path', () => {
    const source = readSrc('app.module.ts');
    expect(source).not.toMatch(/from\s+['"](\.\/prisma\/prisma\.module|\.\/prisma)['"]/);
  });

  it('calls PrismaModule.forRoot or PrismaModule.forRootAsync', () => {
    const source = readSrc('app.module.ts');
    expect(source).toMatch(/PrismaModule\.(forRoot|forRootAsync)\s*\(/);
  });

  it('passes the PrismaClient class as the client option', () => {
    const source = readSrc('app.module.ts');
    expect(source).toMatch(/client\s*:/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Feature services import PrismaService from @nathapp/nestjs-prisma
// ---------------------------------------------------------------------------

describe('AC4 — agents.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('agents/agents.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('agents/agents.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import PrismaService from custom ../prisma/prisma.service', () => {
    const source = readSrc('agents/agents.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — auth.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('auth/auth.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('auth/auth.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('auth/auth.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — auth/guards/api-key-auth.guard.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('auth/guards/api-key-auth.guard.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('auth/guards/api-key-auth.guard.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('auth/guards/api-key-auth.guard.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — projects.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('projects/projects.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('projects/projects.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('projects/projects.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — tickets.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('tickets/tickets.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('tickets/tickets.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('tickets/tickets.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — ticket-transitions.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('tickets/state-machine/ticket-transitions.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('tickets/state-machine/ticket-transitions.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('tickets/state-machine/ticket-transitions.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — comments.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('comments/comments.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('comments/comments.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('comments/comments.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC4 — labels.service.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('labels/labels.service.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('labels/labels.service.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('labels/labels.service.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — Spec files import PrismaService from @nathapp/nestjs-prisma
// ---------------------------------------------------------------------------

describe('AC5 — agents.service.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('agents/agents.service.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('agents/agents.service.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('agents/agents.service.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC5 — auth.service.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('auth/auth.service.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('auth/auth.service.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('auth/auth.service.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC5 — api-key-auth.guard.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('auth/guards/api-key-auth.guard.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('auth/guards/api-key-auth.guard.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('auth/guards/api-key-auth.guard.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC5 — tickets.service.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('tickets/tickets.service.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('tickets/tickets.service.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('tickets/tickets.service.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC5 — comments.service.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('comments/comments.service.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('comments/comments.service.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('comments/comments.service.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC5 — labels.service.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('labels/labels.service.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('labels/labels.service.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('labels/labels.service.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});

describe('AC5 — ticket-transitions.service.spec.ts imports PrismaService from @nathapp/nestjs-prisma', () => {
  it('file exists', () => {
    expect(srcExists('tickets/state-machine/ticket-transitions.service.spec.ts')).toBe(true);
  });

  it('imports PrismaService from @nathapp/nestjs-prisma', () => {
    const source = readSrc('tickets/state-machine/ticket-transitions.service.spec.ts');
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-prisma['"]/);
  });

  it('does not import from custom prisma.service path', () => {
    const source = readSrc('tickets/state-machine/ticket-transitions.service.spec.ts');
    expect(source).not.toMatch(/from\s+['"][^'"]*prisma\/prisma\.service['"]/);
  });
});
