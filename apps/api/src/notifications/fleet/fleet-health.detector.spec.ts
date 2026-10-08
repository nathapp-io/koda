import { FleetHealthDetector } from './fleet-health.detector';

const T0 = new Date('2026-10-09T12:00:00.000Z').getTime();
const CFG = { sweepEnabled: false, runnerOfflineSec: 90, credentialExpiryWarnDays: 7 };
const caps = { nax: { version: '0.83.5', protocols: ['native'] }, sandbox: { available: true, probedAt: '2026-10-09T00:00:00.000Z' }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'] };

describe('FleetHealthDetector (S4a §2.4, D507, D515)', () => {
  const repo = {
    findRunners: jest.fn(async () => [{ id: 'rn1', name: 'wk-mac', enabled: true, lastSeenAt: new Date(T0 - 600_000), capabilities: caps }]),
    findOpen: jest.fn(async () => []),
    open: jest.fn(async () => 'al1'),
    close: jest.fn(async () => 0),
  };
  const outbox = { record: jest.fn(async () => undefined) };
  const order: string[] = [];
  const tx = { run: jest.fn(async (fn: () => Promise<unknown>) => { order.push('tx:start'); const r = await fn(); order.push('tx:end'); return r; }) };
  let detector: FleetHealthDetector;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    detector = new FleetHealthDetector(repo as never, outbox as never, tx as never, CFG as never);
    order.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('boot grace: a runner silent since before the API booted is not reported in the first runnerOfflineSec', async () => {
    expect(await detector.detect(new Date(T0 + 30_000))).toEqual({ opened: 0, closed: 0 });
    expect(repo.open).not.toHaveBeenCalled();
    expect(await detector.detect(new Date(T0 + 91_000))).toEqual({ opened: 1, closed: 0 });
  });

  it('opens the alert and enqueues its event in one transaction, without a project', async () => {
    repo.open.mockImplementationOnce(async () => { order.push('open'); return 'al1'; });
    outbox.record.mockImplementationOnce(async () => { order.push('enqueue'); });
    await detector.detect(new Date(T0 + 120_000));
    expect(order).toEqual(['tx:start', 'open', 'enqueue', 'tx:end']);
    expect(outbox.record).toHaveBeenCalledWith({
      type: 'fleet_health_alert',
      payload: { alertId: 'al1', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null },
      metadata: { eventId: 'al1' },
    });
  });

  it('enqueues nothing when another detect already opened the episode', async () => {
    repo.open.mockResolvedValueOnce(null);
    expect(await detector.detect(new Date(T0 + 120_000))).toEqual({ opened: 0, closed: 0 });
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('closes alerts of a runner that came back', async () => {
    repo.findRunners.mockResolvedValueOnce([{ id: 'rn1', name: 'wk-mac', enabled: true, lastSeenAt: new Date(T0 + 119_000), capabilities: caps }]);
    repo.findOpen.mockResolvedValueOnce([{ id: 'al1', kind: 'runner_offline', subjectKey: 'rn1' }]);
    repo.close.mockResolvedValueOnce(1);
    expect(await detector.detect(new Date(T0 + 120_000))).toEqual({ opened: 0, closed: 1 });
    expect(repo.close).toHaveBeenCalledWith(['al1'], new Date(T0 + 120_000));
  });

  it('does not start a timer when the sweep is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    detector.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
