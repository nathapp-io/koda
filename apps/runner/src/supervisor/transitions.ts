import type { FleetJobStateName } from '@nathapp/fleet-protocol';

/** S1 spec §5.4, runner-reported rows only (server-owned transitions are never emitted by the runner). */
const RUNNER_TRANSITIONS: Readonly<Record<string, readonly FleetJobStateName[]>> = {
  ASSIGNED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['UPLOADING', 'CANCELLED'],
  UPLOADING: ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED'],
};

export const TERMINAL_STATES: readonly FleetJobStateName[] = ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];

export const canEmit = (from: FleetJobStateName, to: FleetJobStateName): boolean => RUNNER_TRANSITIONS[from]?.includes(to) ?? false;

export const isTerminalState = (state: FleetJobStateName): boolean => TERMINAL_STATES.includes(state);
