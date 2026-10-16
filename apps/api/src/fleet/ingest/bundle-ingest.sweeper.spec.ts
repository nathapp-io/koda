import { BundleIngestSweeper, INGEST_SWEEP_MS } from './bundle-ingest.sweeper';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

/**
 * The startup kick drains the ingests a restart left behind, and a RUN ingest then emits
 * `KNOWLEDGE_RUN_INGESTED`. Nest attaches `@OnEvent` listeners only at application bootstrap, after every
 * `onModuleInit`, so the sweeper waits for the emitter's readiness before its first kick: an event emitted
 * earlier would reach no listener and its outcome pass would be lost.
 */
function harness(sweepEnabled = true) {
  let ready!: () => void;
  const readiness = { waitUntilReady: vi.fn(() => new Promise<void>((resolve) => { ready = resolve; })) };
  const ingest = { kick: vi.fn() };
  const sweeper = new BundleIngestSweeper(ingest as never, testFleetConfig({ sweepEnabled }), readiness as never);
  return { sweeper, ingest, readiness, ready: () => ready() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('BundleIngestSweeper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not kick before the event subscribers are ready', async () => {
    const { sweeper, ingest } = harness();

    sweeper.onModuleInit();
    await flush();

    expect(ingest.kick).not.toHaveBeenCalled();
    sweeper.onModuleDestroy();
  });

  it('kicks once when ready, then on every sweep interval', async () => {
    vi.useFakeTimers();
    const { sweeper, ingest, ready } = harness();

    sweeper.onModuleInit();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest.kick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INGEST_SWEEP_MS);
    expect(ingest.kick).toHaveBeenCalledTimes(2);
    sweeper.onModuleDestroy();
  });

  it('starts nothing when the module is destroyed before readiness', async () => {
    vi.useFakeTimers();
    const { sweeper, ingest, ready } = harness();

    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    ready();
    await vi.advanceTimersByTimeAsync(INGEST_SWEEP_MS * 2);

    expect(ingest.kick).not.toHaveBeenCalled();
  });

  it('does nothing while sweeping is disabled', async () => {
    const { sweeper, ingest, readiness } = harness(false);

    sweeper.onModuleInit();
    await flush();

    expect(readiness.waitUntilReady).not.toHaveBeenCalled();
    expect(ingest.kick).not.toHaveBeenCalled();
  });
});
