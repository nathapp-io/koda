import type { NathApplication } from '@nathapp/nestjs-app';
import { enableGracefulShutdown } from './graceful-shutdown';

describe('enableGracefulShutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables the SIGTERM and SIGINT hooks exactly once', () => {
    const enableShutdownHooks = vi.fn().mockReturnThis();
    const app = { enableShutdownHooks } as unknown as NathApplication;

    enableGracefulShutdown(app);

    expect(enableShutdownHooks).toHaveBeenCalledTimes(1);
    expect(enableShutdownHooks).toHaveBeenCalledWith(['SIGTERM', 'SIGINT']);
  });
});
