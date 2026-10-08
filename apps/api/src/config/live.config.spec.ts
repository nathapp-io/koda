import { liveConfig } from './live.config';

describe('liveConfig', () => {
  const saved = process.env['LIVE_HEARTBEAT_MS'];

  afterEach(() => {
    if (saved === undefined) delete process.env['LIVE_HEARTBEAT_MS'];
    else process.env['LIVE_HEARTBEAT_MS'] = saved;
  });

  it('defaults to a 25 s heartbeat and 5 streams per user', () => {
    delete process.env['LIVE_HEARTBEAT_MS'];
    expect(liveConfig()).toEqual({ heartbeatMs: 25000, maxStreamsPerUser: 10 });
  });

  it('reads LIVE_HEARTBEAT_MS', () => {
    process.env['LIVE_HEARTBEAT_MS'] = '300';
    expect(liveConfig().heartbeatMs).toBe(300);
  });

  it('never goes below 100 ms', () => {
    process.env['LIVE_HEARTBEAT_MS'] = '5';
    expect(liveConfig().heartbeatMs).toBe(100);
  });

  it('rejects a non-numeric value', () => {
    process.env['LIVE_HEARTBEAT_MS'] = '25s';
    expect(() => liveConfig()).toThrow();
  });
});
