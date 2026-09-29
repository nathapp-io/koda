import { ACTIVE_STATES, canTransition, isTerminal, TERMINAL_STATES } from './job-state';

describe('job state table (spec §5.4)', () => {
  it.each([
    ['QUEUED', 'ASSIGNED', 'server'],
    ['QUEUED', 'CANCELLED', 'server'],
    ['ASSIGNED', 'CANCELLED', 'server'],
    ['ASSIGNED', 'CRASHED', 'server'],
    ['RUNNING', 'CRASHED', 'server'],
    ['UPLOADING', 'CRASHED', 'server'], // plan D11
    ['CRASHED', 'QUEUED', 'server'],
    ['FAILED', 'QUEUED', 'server'],
    ['CANCELLED', 'QUEUED', 'server'],
    ['ASSIGNED', 'RUNNING', 'runner'],
    ['ASSIGNED', 'FAILED', 'runner'],
    ['ASSIGNED', 'CANCELLED', 'runner'],
    ['RUNNING', 'UPLOADING', 'runner'],
    ['RUNNING', 'CANCELLED', 'runner'],
    ['UPLOADING', 'COMPLETED', 'runner'],
    ['UPLOADING', 'FAILED', 'runner'],
    ['UPLOADING', 'ESCALATED', 'runner'],
    ['UPLOADING', 'CANCELLED', 'runner'],
  ])('allows %s -> %s by %s', (from, to, by) => {
    expect(canTransition(from, to, by as 'server' | 'runner')).toBe(true);
  });

  it.each([
    ['QUEUED', 'RUNNING', 'runner'],
    ['RUNNING', 'COMPLETED', 'runner'],
    ['RUNNING', 'FAILED', 'runner'],
    ['COMPLETED', 'QUEUED', 'server'],
    ['ESCALATED', 'QUEUED', 'server'],
    ['RUNNING', 'CANCELLED', 'server'],
    ['CRASHED', 'RUNNING', 'runner'],
    ['QUEUED', 'QUEUED', 'server'],
    ['BOGUS', 'QUEUED', 'server'],
    ['constructor', 'QUEUED', 'server'],
  ])('refuses %s -> %s by %s', (from, to, by) => {
    expect(canTransition(from, to, by as 'server' | 'runner')).toBe(false);
  });

  it('partitions the states', () => {
    expect([...ACTIVE_STATES, ...TERMINAL_STATES].sort()).toEqual(
      ['ASSIGNED', 'CANCELLED', 'COMPLETED', 'CRASHED', 'ESCALATED', 'FAILED', 'QUEUED', 'RUNNING', 'UPLOADING'],
    );
    expect(isTerminal('ESCALATED')).toBe(true);
    expect(isTerminal('UPLOADING')).toBe(false);
  });
});
