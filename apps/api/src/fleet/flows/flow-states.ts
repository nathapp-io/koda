export const FleetFlowState = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  RUNNING: 'RUNNING',
  WAITING_MERGE: 'WAITING_MERGE',
  WAITING_ANSWER: 'WAITING_ANSWER',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
} as const;

export type FleetFlowState = (typeof FleetFlowState)[keyof typeof FleetFlowState];

const transitions: Readonly<Record<FleetFlowState, readonly FleetFlowState[]>> = {
  PENDING: ['APPROVED', 'STOPPED', 'PENDING'],
  APPROVED: ['RUNNING', 'PENDING', 'STOPPED'],
  RUNNING: ['WAITING_MERGE', 'WAITING_ANSWER', 'COMPLETED', 'STOPPED', 'PENDING'],
  WAITING_MERGE: ['RUNNING', 'STOPPED'],
  WAITING_ANSWER: ['RUNNING', 'PENDING', 'STOPPED'],
  COMPLETED: [],
  STOPPED: [],
};
const states = new Set<string>(Object.values(FleetFlowState));

export function canTransitionFlow(from: string, to: string): boolean {
  return states.has(from) && states.has(to) && transitions[from as FleetFlowState].includes(to as FleetFlowState);
}

export function isLiveFlowState(state: string): boolean {
  return states.has(state) && state !== FleetFlowState.COMPLETED && state !== FleetFlowState.STOPPED;
}
