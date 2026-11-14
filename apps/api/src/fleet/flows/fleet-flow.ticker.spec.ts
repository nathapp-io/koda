import { Logger } from '@nestjs/common';
import { actorTypeFor, currentContext } from '../../action-context/action-context';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { PENDING_SURFACE_KEYS } from '../../permissions/catalog';
import { SYSTEM_WRITER_METADATA } from '../../permissions/system-writer.decorator';
import type { AdvanceableFlow, IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import type { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import type { FleetFlowTicker } from './fleet-flow.ticker';

const NOW = new Date('2026-11-07T12:00:00Z');
const flow = (id: string, createdByType: 'USER' | 'AGENT' = 'USER'): AdvanceableFlow => ({
  id, createdByType, createdById: `creator-${id}`,
});

describe('FleetFlowTicker', () => {
  let ticker: FleetFlowTicker;
  let Ticker: typeof FleetFlowTicker;
  const cfg = testFleetConfig({ flowTickMs: 1234 });
  const steps = { listAdvanceable: vi.fn<IFleetFlowStepRepository['listAdvanceable']>() };
  const engine = {
    advance: vi.fn<FleetFlowAdvanceService['advance']>(),
    stopFailedFlow: vi.fn<FleetFlowAdvanceService['stopFailedFlow']>(),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    steps.listAdvanceable.mockReset().mockResolvedValue([]);
    engine.advance.mockReset().mockResolvedValue(undefined);
    engine.stopFailedFlow.mockReset().mockResolvedValue(true);
    cfg.sweepEnabled = false;
    Ticker = (await import('./fleet-flow.ticker')).FleetFlowTicker;
    ticker = new Ticker(steps as unknown as IFleetFlowStepRepository, engine as unknown as FleetFlowAdvanceService, cfg);
  });
  afterEach(() => {
    ticker?.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC-5: starts no interval when sweeps are disabled', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    ticker.onModuleInit();
    expect(interval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC-6: starts an unrefed configurable interval, polls and clears it on destroy', async () => {
    cfg.sweepEnabled = true;
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const poll = vi.spyOn(ticker, 'poll').mockResolvedValue(undefined);
    ticker.onModuleInit();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1234);
    const timer = interval.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1234);
    expect(poll).toHaveBeenCalledTimes(1);
    ticker.onModuleDestroy();
    expect(clear).toHaveBeenCalledWith(timer);
    expect(vi.getTimerCount()).toBe(0);
    ticker.onModuleDestroy();
  });

  it('AC-7: advances each returned flow once, in order, with the same now', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('f1'), flow('f2')]);
    await ticker.tick(NOW);
    expect(steps.listAdvanceable.mock.calls).toEqual([[50, null]]);
    expect(engine.advance.mock.calls).toEqual([['f1', NOW], ['f2', NOW]]);
  });

  it('AC-8: pages with the last id and stops at a short page', async () => {
    const first = Array.from({ length: 50 }, (_, i) => flow(`f${i}`));
    steps.listAdvanceable.mockImplementation(async (_limit, afterId) => afterId === null ? first : [flow('last')]);
    await ticker.tick(NOW);
    expect(steps.listAdvanceable.mock.calls).toEqual([[50, null], [50, 'f49']]);
    expect(engine.advance).toHaveBeenCalledTimes(51);
    expect(engine.advance).toHaveBeenLastCalledWith('last', NOW);
  });

  it('bounds a pass at 10 full pages and warns on overflow', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    steps.listAdvanceable.mockImplementation(async (_limit, afterId) => {
      const start = afterId === null ? 0 : Number(afterId) + 1;
      return Array.from({ length: 50 }, (_, i) => flow(String(start + i)));
    });
    await ticker.tick(NOW);
    expect(steps.listAdvanceable).toHaveBeenCalledTimes(10);
    expect(engine.advance).toHaveBeenCalledTimes(500);
    expect(engine.advance).toHaveBeenLastCalledWith('499', NOW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  it('AC-9/10: advances as SYSTEM flow on each creator behalf, including AGENT attribution', async () => {
    const rows = [flow('f1'), flow('f2', 'AGENT')];
    steps.listAdvanceable.mockResolvedValue(rows);
    const observed: unknown[] = [];
    engine.advance.mockImplementation(async (id) => {
      await Promise.resolve(); // Context survives the async engine call.
      observed.push({ context: currentContext(), actorType: actorTypeFor(`creator-${id}`) });
    });
    await ticker.tick(NOW);
    expect(observed).toEqual(rows.map((row) => ({
      context: expect.objectContaining({
        actor: { type: 'SYSTEM', id: 'flow' }, origin: 'system',
        onBehalfOf: { type: row.createdByType, id: row.createdById },
      }),
      actorType: row.createdByType,
    })));
    expect(engine.advance).toHaveBeenCalledTimes(2);
    expect(currentContext()).toBeUndefined();
  });

  it('AC-11: logs the failing flow id and continues to the next flow', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockClear();
    steps.listAdvanceable.mockResolvedValue([flow('bad-flow'), flow('next-flow')]);
    engine.advance.mockRejectedValueOnce(new Error('broken'));
    await ticker.tick(NOW);
    expect(engine.advance.mock.calls).toEqual([['bad-flow', NOW], ['next-flow', NOW]]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bad-flow'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });

  it('AC-12: a concurrent poll returns immediately; a later poll runs again', async () => {
    let release!: () => void;
    steps.listAdvanceable.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve([]);
    }));
    const first = ticker.poll();
    await ticker.poll();
    expect(steps.listAdvanceable).toHaveBeenCalledTimes(1);
    release();
    await first;
    await ticker.poll();
    expect(steps.listAdvanceable).toHaveBeenCalledTimes(2);
  });

  it('resets single-flight in finally after a repository failure', async () => {
    steps.listAdvanceable.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(ticker.poll()).rejects.toThrow('database unavailable');
    await ticker.poll();
    expect(steps.listAdvanceable).toHaveBeenCalledTimes(2);
  });

  it('logs an interval poll failure without leaving an unhandled rejection', async () => {
    cfg.sweepEnabled = true;
    const error = vi.spyOn(Logger.prototype, 'error').mockClear();
    vi.spyOn(ticker, 'poll').mockRejectedValue(new Error('poll failed'));
    ticker.onModuleInit();
    await vi.advanceTimersByTimeAsync(1234);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('poll failed'));
  });

  it('AC-13: declares the now-live system.flow.advance writer', () => {
    expect(Reflect.getMetadata(SYSTEM_WRITER_METADATA, Ticker)).toBe('system.flow.advance');
    expect(PENDING_SURFACE_KEYS.has('system.flow.advance')).toBe(false);
  });

  it('AC-1: exports the consecutive failure threshold', async () => {
    const tickerModule = await import('./fleet-flow.ticker');
    expect(tickerModule.FLOW_FAILURE_STOP_AFTER).toBe(5);
  });

  it('AC-2/3: stops only on the fifth rejection and passes that failure detail', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    engine.advance.mockRejectedValue(new Error('boom-5'));
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    expect(engine.stopFailedFlow).not.toHaveBeenCalled();
    await ticker.tick(NOW);
    expect(engine.stopFailedFlow).toHaveBeenCalledTimes(1);
    expect(engine.stopFailedFlow).toHaveBeenCalledWith('F', 'boom-5', NOW);
  });

  it('AC-4: invokes the stop under the same system writer and creator attribution', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F', 'AGENT')]);
    engine.advance.mockRejectedValue(new Error('broken'));
    let observed: unknown;
    engine.stopFailedFlow.mockImplementation(async () => {
      observed = currentContext();
      return true;
    });
    for (let i = 0; i < 5; i++) await ticker.tick(NOW);
    expect(observed).toEqual(expect.objectContaining({
      actor: { type: 'SYSTEM', id: 'flow' }, origin: 'system',
      onBehalfOf: { type: 'AGENT', id: 'creator-F' },
    }));
    expect(currentContext()).toBeUndefined();
  });

  it('AC-5: a successful advance resets the consecutive failure count', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    engine.advance.mockRejectedValue(new Error('broken'));
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    engine.advance.mockResolvedValueOnce(undefined);
    await ticker.tick(NOW);
    engine.advance.mockRejectedValue(new Error('broken'));
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    expect(engine.stopFailedFlow).not.toHaveBeenCalled();
  });

  it('AC-6: a resolved false stop clears the counter', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    engine.advance.mockRejectedValue(new Error('broken'));
    engine.stopFailedFlow.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) await ticker.tick(NOW);
    await ticker.tick(NOW);
    expect(engine.stopFailedFlow).toHaveBeenCalledTimes(1);
  });

  it('AC-7/8: rejected stop is logged, does not block later flows, and retries next tick', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockClear();
    steps.listAdvanceable.mockResolvedValue([flow('F'), flow('G')]);
    engine.advance.mockImplementation(async (id) => {
      if (id === 'F') throw new Error('broken');
    });
    engine.stopFailedFlow.mockRejectedValue(new Error('stop failed'));
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    await expect(ticker.tick(NOW)).resolves.toBeUndefined();
    expect(engine.advance).toHaveBeenLastCalledWith('G', NOW);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('stop failed'));
    await ticker.tick(NOW);
    expect(engine.stopFailedFlow).toHaveBeenCalledTimes(2);
  });

  it('AC-9: resolving advances for another flow do not affect F failures', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F'), flow('G')]);
    engine.advance.mockImplementation(async (id) => {
      if (id === 'F') throw new Error('broken');
    });
    for (let i = 0; i < 5; i++) await ticker.tick(NOW);
    expect(engine.stopFailedFlow.mock.calls.map(([id]) => id)).toEqual(['F']);
  });

  it('AC-10: a complete scan prunes failure counts for flows no longer listed', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    engine.advance.mockRejectedValue(new Error('broken'));
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    steps.listAdvanceable.mockResolvedValue([]);
    await ticker.tick(NOW);
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    expect(engine.stopFailedFlow).not.toHaveBeenCalled();
    await ticker.tick(NOW);
    expect(engine.stopFailedFlow).toHaveBeenCalledTimes(1);
  });

  it('AC-11: resumed cursor scans do not prune unseen failure counts', async () => {
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    engine.advance.mockRejectedValue(new Error('broken'));
    for (let i = 0; i < 4; i++) await ticker.tick(NOW);
    const page = Array.from({ length: 50 }, (_, i) => flow(String(i)));
    steps.listAdvanceable.mockResolvedValue(page);
    await ticker.tick(NOW);
    // The next tick resumes after the page limit but finds no F; it must not prune F's count.
    steps.listAdvanceable.mockResolvedValue([]);
    await ticker.tick(NOW);
    steps.listAdvanceable.mockResolvedValue([flow('F')]);
    await ticker.tick(NOW);
    expect(engine.stopFailedFlow).toHaveBeenCalledWith('F', 'broken', NOW);
  });

  it('AC-12/13/14: commits a fair cursor only after a successful tick', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => flow(String(i)));
    steps.listAdvanceable.mockImplementation(async () => fullPage);
    await ticker.tick(NOW);
    steps.listAdvanceable.mockResolvedValue([]);
    await ticker.tick(NOW);
    expect(steps.listAdvanceable.mock.calls[10][1]).toBe('49');
    steps.listAdvanceable.mockResolvedValue([]);
    await ticker.tick(NOW);
    expect(steps.listAdvanceable.mock.calls[11][1]).toBeNull();

    steps.listAdvanceable.mockImplementation(async () => fullPage);
    await ticker.tick(NOW);
    const beforeFailureCallCount = steps.listAdvanceable.mock.calls.length;
    steps.listAdvanceable.mockRejectedValueOnce(new Error('list failed'));
    await expect(ticker.tick(NOW)).rejects.toThrow('list failed');
    steps.listAdvanceable.mockResolvedValue([]);
    await ticker.tick(NOW);
    expect(steps.listAdvanceable.mock.calls[beforeFailureCallCount][1]).toBe('49');
    expect(steps.listAdvanceable.mock.calls[beforeFailureCallCount + 1][1]).toBe('49');
  });
});
