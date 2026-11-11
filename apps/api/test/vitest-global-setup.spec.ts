const lifecycle = vi.hoisted(() => ({ setup: vi.fn(), teardown: vi.fn() }));
vi.mock('./global-setup', () => ({ default: lifecycle.setup }));
vi.mock('./global-teardown', () => ({ default: lifecycle.teardown }));

import { setup } from './vitest-global-setup';

describe('Vitest database lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('provisions and tears down once at the root, including a run with many DB projects', async () => {
    for (let i = 0; i < 24; i++) {
      const cleanup = await setup({ isRootProject: () => false });
      expect(cleanup).toBeUndefined();
    }
    expect(lifecycle.setup).not.toHaveBeenCalled();
    const cleanup = await setup({ isRootProject: () => true });
    expect(lifecycle.setup).toHaveBeenCalledTimes(1);
    expect(lifecycle.teardown).not.toHaveBeenCalled();
    expect(cleanup).toBeTypeOf('function');
    await cleanup?.();
    expect(lifecycle.teardown).toHaveBeenCalledTimes(1);
  });
});
