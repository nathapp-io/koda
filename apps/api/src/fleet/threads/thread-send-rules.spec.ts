import { Prisma } from '../../generated/prisma/client';
import { sendRefusal, THREAD_MIN_PROTOCOL_VERSION, type ThreadSendState } from './thread-send-rules';

const open: ThreadSendState = { threadsEnabled: true, status: 'ACTIVE', costUsd: '0', maxCostUsd: '5' };
const withState = (over: Partial<ThreadSendState>): ThreadSendState => ({ ...open, ...over });

describe('sendRefusal', () => {
  it('lets a send through when every check passes', () => {
    expect(sendRefusal(open)).toBeNull();
  });

  it('refuses disabled threads only when the flag is explicitly false', () => {
    expect(sendRefusal(withState({ threadsEnabled: false }))).toBe('disabled');
    expect(sendRefusal({ status: 'ACTIVE', costUsd: '0', maxCostUsd: '5' })).toBeNull();
  });

  it('answers archived before the cost cap (archived wins over costCap)', () => {
    expect(sendRefusal(withState({ status: 'ARCHIVED', costUsd: '5', maxCostUsd: '5' }))).toBe('archived');
  });

  it('refuses at the cost cap, not below it', () => {
    expect(sendRefusal(withState({ costUsd: '5', maxCostUsd: '5' }))).toBe('costCap');
    expect(sendRefusal(withState({ costUsd: '4.9999', maxCostUsd: '5' }))).toBeNull();
  });

  it('compares cost as decimals, not floats', () => {
    expect(sendRefusal(withState({ costUsd: new Prisma.Decimal('0.3'), maxCostUsd: new Prisma.Decimal('0.3') }))).toBe('costCap');
  });

  it('refuses under a paused budget policy', () => {
    expect(sendRefusal(withState({ pausedPolicy: { id: 'policy-1' } }))).toBe('budgetPaused');
  });

  it('refuses an offline pinned runner', () => {
    expect(sendRefusal(withState({ runner: { online: false, protocolVersion: THREAD_MIN_PROTOCOL_VERSION } }))).toBe('runnerOffline');
  });

  it('refuses a runner below the thread protocol version', () => {
    expect(sendRefusal(withState({ runner: { online: true, protocolVersion: THREAD_MIN_PROTOCOL_VERSION - 1 } }))).toBe('runnerOutdated');
  });

  it('refuses while the current job is uploading', () => {
    expect(sendRefusal(withState({ job: { state: 'UPLOADING', closeRequested: false } }))).toBe('closing');
  });

  it('refuses a running job that has a THREAD_CLOSE at its epoch', () => {
    expect(sendRefusal(withState({ job: { state: 'RUNNING', closeRequested: true } }))).toBe('closing');
  });

  it('allows a running job with no close queued', () => {
    expect(sendRefusal(withState({ job: { state: 'RUNNING', closeRequested: false } }))).toBeNull();
  });

  it('refuses while a turn is pending or streaming', () => {
    expect(sendRefusal(withState({ turnInFlight: true }))).toBe('turnRunning');
  });

  it('refuses while the current job is queued or assigned', () => {
    expect(sendRefusal(withState({ job: { state: 'QUEUED', closeRequested: false } }))).toBe('turnRunning');
    expect(sendRefusal(withState({ job: { state: 'ASSIGNED', closeRequested: false } }))).toBe('turnRunning');
  });

  it('checks in the documented order: budget before the runner and job checks', () => {
    expect(sendRefusal(withState({
      pausedPolicy: { id: 'p' }, runner: { online: false, protocolVersion: 1 }, job: { state: 'UPLOADING', closeRequested: false },
    }))).toBe('budgetPaused');
  });
});
