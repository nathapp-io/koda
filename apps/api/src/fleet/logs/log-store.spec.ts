import { logKey } from './log-store';

describe('logKey', () => {
  it('US-001 AC1: builds the thread stream key from validated parts', () => {
    expect(logKey('j1', 1, 'thread')).toBe('logs/j1/1/thread.log');
  });

  it('US-001: still builds the readable stream keys', () => {
    expect(logKey('j1', 2, 'run')).toBe('logs/j1/2/run.log');
  });

  it('US-001: refuses a stream name that is neither readable nor a thread upload stream', () => {
    expect(() => logKey('j1', 1, 'prompt' as never)).toThrow(/invalid log key part/);
  });
});
