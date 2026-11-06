import { canTransitionFlow, isLiveFlowState } from './flow-states';

describe('flow state rules', () => {
  it.each([
    ['PENDING', 'APPROVED'], ['PENDING', 'STOPPED'], ['PENDING', 'PENDING'],
    ['APPROVED', 'RUNNING'], ['APPROVED', 'PENDING'], ['APPROVED', 'STOPPED'],
    ['RUNNING', 'WAITING_MERGE'], ['RUNNING', 'WAITING_ANSWER'], ['RUNNING', 'COMPLETED'], ['RUNNING', 'STOPPED'], ['RUNNING', 'PENDING'],
    ['WAITING_MERGE', 'RUNNING'], ['WAITING_MERGE', 'STOPPED'],
    ['WAITING_ANSWER', 'RUNNING'], ['WAITING_ANSWER', 'PENDING'], ['WAITING_ANSWER', 'STOPPED'],
  ])('allows %s -> %s', (from, to) => expect(canTransitionFlow(from, to)).toBe(true));

  it.each([
    ['PENDING', 'RUNNING'], ['COMPLETED', 'PENDING'], ['STOPPED', 'APPROVED'],
    ['COMPLETED', 'COMPLETED'], ['STOPPED', 'STOPPED'], ['unknown', 'PENDING'],
  ])('rejects %s -> %s', (from, to) => expect(canTransitionFlow(from, to)).toBe(false));

  it.each(['PENDING', 'APPROVED', 'RUNNING', 'WAITING_MERGE', 'WAITING_ANSWER'])('%s is live', (state) => {
    expect(isLiveFlowState(state)).toBe(true);
  });
  it.each(['COMPLETED', 'STOPPED', 'unknown'])('%s is not live', (state) => {
    expect(isLiveFlowState(state)).toBe(false);
  });
});
