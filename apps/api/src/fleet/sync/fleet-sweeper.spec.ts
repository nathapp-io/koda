import { FleetSweeper } from './fleet-sweeper';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

describe('FleetSweeper scheduling', () => {
  afterEach(() => jest.useRealTimers());

  it('starts a 30s interval only when enabled, and stops it on shutdown', () => {
    jest.useFakeTimers();
    const off = new FleetSweeper({} as never, {} as never, {} as never, {} as never, testFleetConfig({ sweepEnabled: false }));
    off.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    const on = new FleetSweeper({} as never, {} as never, {} as never, {} as never, testFleetConfig({ sweepEnabled: true }));
    on.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    on.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
