import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import { SUPPORTED_FLEET_PROTOCOL_VERSIONS, isSupportedProtocolVersion } from './protocol';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('fleet protocol', () => {
  it('supports the package protocol version', () => {
    expect(SUPPORTED_FLEET_PROTOCOL_VERSIONS).toContain(FLEET_PROTOCOL_VERSION);
  });

  it.each([
    [1, true],
    [0, false],
    [2, false],
    ['1', false],
    [1.5, false],
    [undefined, false],
  ])('isSupportedProtocolVersion(%p) is %p', (value, expected) => {
    expect(isSupportedProtocolVersion(value)).toBe(expected);
  });

  // The production image never ships packages/ (apps/api/Dockerfile final stage),
  // so production code may only use erased type imports from the package.
  it('production code imports @nathapp/fleet-protocol with `import type` only', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /^\s*(import|export)\s+(?!type\b)[^;]*from\s+['"]@nathapp\/fleet-protocol['"]/m.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
