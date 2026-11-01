import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { ReviewEventMintPoller } from './review-event-mint.poller';
import { ReviewEventMinter } from './review-event.minter';

describe('ReviewEventMintPoller', () => {
  afterEach(() => vi.useRealTimers());

  it('AC-4: calls minter once after configured interval when sweeping enabled', () => {
    vi.useFakeTimers();
    const minter = { run: vi.fn().mockResolvedValue(undefined) };
    const poller = new ReviewEventMintPoller(minter as unknown as ReviewEventMinter, testFleetConfig({ sweepEnabled: true }));
    poller.onModuleInit();
    vi.advanceTimersByTime(300_000);
    expect(minter.run).toHaveBeenCalledExactlyOnceWith();
    poller.onModuleDestroy();
  });

  it('AC-5: does not run while sweeping is disabled', () => {
    vi.useFakeTimers();
    const minter = { run: vi.fn().mockResolvedValue(undefined) };
    const poller = new ReviewEventMintPoller(minter as unknown as ReviewEventMinter, testFleetConfig({ sweepEnabled: false }));
    poller.onModuleInit(); vi.advanceTimersByTime(600_000);
    expect(minter.run).not.toHaveBeenCalled();
    poller.onModuleDestroy();
  });

  it('AC-6: destroy stops future ticks', () => {
    vi.useFakeTimers();
    const minter = { run: vi.fn().mockResolvedValue(undefined) };
    const poller = new ReviewEventMintPoller(minter as unknown as ReviewEventMinter, testFleetConfig({ sweepEnabled: true }));
    poller.onModuleInit(); vi.advanceTimersByTime(300_000); poller.onModuleDestroy(); vi.advanceTimersByTime(600_000);
    expect(minter.run).toHaveBeenCalledExactlyOnceWith();
  });
});
