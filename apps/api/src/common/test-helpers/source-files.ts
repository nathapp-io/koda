import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every non-spec TypeScript file under `dir`, recursively. Used by specs that
 * guard a codebase-wide rule (one write site, one construction path).
 */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}
