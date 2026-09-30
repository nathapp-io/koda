import { describe, expect, test } from 'bun:test';
import type { FleetJobStateName } from '@nathapp/fleet-protocol';
import { TERMINAL_STATES, canEmit, isTerminalState } from './transitions';

const ALL: FleetJobStateName[] = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];
const ALLOWED: Record<string, string[]> = {
  ASSIGNED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['UPLOADING', 'CANCELLED'],
  UPLOADING: ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED'],
};

describe('canEmit (S1 spec §5.4, runner-reported rows)', () => {
  test.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))('%s -> %s', (from, to) => {
    expect(canEmit(from, to)).toBe(ALLOWED[from]?.includes(to) ?? false);
  });
  test('terminal states are terminal and have no exits', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'CRASHED', 'ESCALATED', 'FAILED']);
    for (const s of ALL) expect(isTerminalState(s)).toBe(TERMINAL_STATES.includes(s));
    for (const s of TERMINAL_STATES) for (const to of ALL) expect(canEmit(s, to)).toBe(false);
  });
});
