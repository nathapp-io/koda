import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { APPROVAL_TEXT_MAX_BYTES as PACKAGE_APPROVAL_TEXT_MAX_BYTES, FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import type { FleetCommandTypeName, FleetJobKindName, FleetJobStateName } from '@nathapp/fleet-protocol';
import { APPROVAL_TEXT_MAX_BYTES, DEFAULT_APPROVAL_TIMEOUT_SEC, SUPPORTED_FLEET_PROTOCOL_VERSIONS, isSupportedProtocolVersion } from './protocol';
import { FleetCommandType, FleetJobKind, FleetJobState } from '../../common/enums';

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

  it.each([[1, true], [2, true], [3, true], [4, true], [0, false], [5, false], ['2', false], [1.5, false], [undefined, false]])(
    'isSupportedProtocolVersion(%p) is %p', (value, expected) => {
      expect(isSupportedProtocolVersion(value)).toBe(expected);
    },
  );

  it('keeps the local approval text cap equal to the package (the API image does not ship the package)', () => {
    expect(APPROVAL_TEXT_MAX_BYTES).toBe(PACKAGE_APPROVAL_TEXT_MAX_BYTES);
    expect(DEFAULT_APPROVAL_TIMEOUT_SEC).toBe(600);
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

describe('API enums match the protocol unions', () => {
  // Record<Union, true> fails to compile if a union member is missing or extra.
  const states: Record<FleetJobStateName, true> = {
    QUEUED: true, ASSIGNED: true, RUNNING: true, UPLOADING: true, COMPLETED: true,
    FAILED: true, ESCALATED: true, CRASHED: true, CANCELLED: true,
  };
  const kinds: Record<FleetJobKindName, true> = { RUN: true, PLAN: true, CONFIG_EDIT: true, CONFIG_DRIFT: true, THREAD: true };
  const commands: Record<FleetCommandTypeName, true> = {
    ASSIGN: true, CANCEL: true, READOPT: true, ABANDON: true, APPROVAL_ANSWER: true,
    THREAD_INPUT: true, THREAD_ANSWER: true, THREAD_STOP_TURN: true, THREAD_CLOSE: true, THREAD_PUBLISH: true,
  };

  it.each([
    ['FleetJobState', FleetJobState, states],
    ['FleetJobKind', FleetJobKind, kinds],
    ['FleetCommandType', FleetCommandType, commands],
  ])('%s', (_name, apiConst, union) => {
    expect(Object.values(apiConst).sort()).toEqual(Object.keys(union).sort());
  });
});
