import { Logger } from '@nestjs/common';
import type { IFleetConfig } from '../../config/fleet.config';
import { FleetPrReviewPass } from './fleet-pr-review.pass';
import { FleetPrReviewPoller } from './fleet-pr-review.poller';

type ReviewPass = Pick<FleetPrReviewPass, 'run'>;
type PollerConfig = Pick<IFleetConfig, 'sweepEnabled' | 'prReviewEnabled' | 'prReviewPollMs'>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FleetPrReviewPoller', () => {
  let pass: ReviewPass;
  let config: PollerConfig;
  let poller: FleetPrReviewPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    pass = { run: vi.fn().mockResolvedValue(undefined) };
    config = { sweepEnabled: true, prReviewEnabled: true, prReviewPollMs: 1234 };
    poller = new FleetPrReviewPoller(pass, config);
  });

  afterEach(() => {
    poller.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC-1: poll calls run once with a Date', async () => {
    await poller.poll();

    expect(pass.run).toHaveBeenCalledTimes(1);
    expect(pass.run).toHaveBeenCalledWith(expect.any(Date));
  });

  it('AC-2: an overlapping poll returns without starting another run', async () => {
    const work = deferred<void>();
    vi.mocked(pass.run).mockReturnValueOnce(work.promise);

    const first = poller.poll();
    await poller.poll();
    expect(pass.run).toHaveBeenCalledTimes(1);

    work.resolve();
    await first;
    await poller.poll();
    expect(pass.run).toHaveBeenCalledTimes(2);
  });

  it('AC-3: poll resolves and logs an error when run rejects', async () => {
    const error = new Error('failed pass');
    vi.mocked(pass.run).mockRejectedValueOnce(error);
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(poller.poll()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('failed pass'));
  });

  it('AC-4: both gates start an unref-ed interval at the configured rate that polls', async () => {
    const originalSetInterval = globalThis.setInterval;
    const unref = vi.fn();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      const timer = originalSetInterval(handler, timeout, ...args);
      timer.unref = unref;
      return timer;
    });
    poller.onModuleInit();

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1234);
    expect(pass.run).toHaveBeenCalledTimes(1);
  });

  it('AC-5: onModuleDestroy clears the scheduled interval', async () => {
    poller.onModuleInit();
    poller.onModuleDestroy();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pass.run).not.toHaveBeenCalled();
  });

  it('AC-6: prReviewEnabled false prevents starting the interval', () => {
    config.prReviewEnabled = false;
    poller.onModuleInit();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC-7: sweepEnabled false prevents starting the interval', () => {
    config.sweepEnabled = false;
    poller.onModuleInit();

    expect(vi.getTimerCount()).toBe(0);
  });
});
