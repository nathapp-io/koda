import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  AGENT_RESULT_LIMITS,
  APPROVAL_TEXT_MAX_BYTES as PACKAGE_APPROVAL_TEXT_MAX_BYTES,
  FLEET_PROTOCOL_VERSION,
  HANDOFF_MAX_RUNS as PACKAGE_HANDOFF_MAX_RUNS,
  HANDOFF_RECORD_FILES as PACKAGE_HANDOFF_RECORD_FILES,
  HANDOFF_RECORD_MAX_BYTES as PACKAGE_HANDOFF_RECORD_MAX_BYTES,
  HANDOFF_RUN_ID_RE as PACKAGE_HANDOFF_RUN_ID_RE,
} from '@nathapp/fleet-protocol';
import type { FleetCommandTypeName, FleetJobKindName, FleetJobStateName } from '@nathapp/fleet-protocol';
import { APPROVAL_TEXT_MAX_BYTES, DEFAULT_APPROVAL_TIMEOUT_SEC, SUPPORTED_FLEET_PROTOCOL_VERSIONS, isSupportedProtocolVersion } from './protocol';
import { FleetCommandType, FleetJobKind, FleetJobState } from '../../common/enums';
import { AGENT_RESULT_LIMITS as API_AGENT_RESULT_LIMITS } from './agent-jobs';
import {
  HANDOFF_MAX_RUNS,
  HANDOFF_RECORD_FILES,
  HANDOFF_RECORD_MAX_BYTES,
  HANDOFF_RUN_ID_RE,
} from '../flows/flow-handoff-input';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('fleet protocol', () => {
  it('pins the API agent result limits to the protocol package', () => {
    const expected = { budgetBytes: 12_288, maxOutputBytes: 8_192, maxDeniedAsks: 10, maxAskChars: 500, maxToolChars: 128, maxModelChars: 200 };
    expect(AGENT_RESULT_LIMITS).toEqual(expected);
    expect(API_AGENT_RESULT_LIMITS).toEqual(AGENT_RESULT_LIMITS);
  });

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

  // US-003 (AC-1): the handoff limits live in the package, because the runner enforces them too.
  // The API image does not ship the package, so the API keeps its own copies: they must not drift.
  it('pins the API handoff limits to the protocol package', () => {
    expect(HANDOFF_MAX_RUNS).toBe(PACKAGE_HANDOFF_MAX_RUNS);
    expect(HANDOFF_RECORD_MAX_BYTES).toBe(PACKAGE_HANDOFF_RECORD_MAX_BYTES);
    expect(HANDOFF_RUN_ID_RE.source).toBe(PACKAGE_HANDOFF_RUN_ID_RE.source);
    expect(HANDOFF_RUN_ID_RE.flags).toBe(PACKAGE_HANDOFF_RUN_ID_RE.flags);
    expect([...HANDOFF_RECORD_FILES]).toEqual([...PACKAGE_HANDOFF_RECORD_FILES]);
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
  const kinds: Record<FleetJobKindName, true> = { RUN: true, PLAN: true, CONFIG_EDIT: true, CONFIG_DRIFT: true, THREAD: true, REVIEW: true, FIX: true, AGENT: true };
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
