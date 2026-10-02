import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { FleetTestHooksController } from './fleet-test-hooks.controller';

const DUE = new Date('2026-10-02T03:00:00.000Z');
const RESULT = { claimed: 1, dispatched: 1, coalesced: 0, skipped: 0, disabled: 0, failed: 0 };

function build(enabled: boolean, found = true) {
  const ticker = { tick: jest.fn(async () => RESULT) };
  const repo = { findById: jest.fn(async () => (found ? { id: 's1', nextFireAt: DUE } : null)) };
  const controller = new FleetTestHooksController(ticker as never, repo as never, { testHooksEnabled: enabled });
  return { ticker, repo, controller };
}

describe('FleetTestHooksController (3b D213)', () => {
  it('answers 404 and touches nothing while the hooks are off', async () => {
    const h = build(false);
    await expect(h.controller.fire('s1')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(h.repo.findById).not.toHaveBeenCalled();
    expect(h.ticker.tick).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown schedule', async () => {
    const h = build(true, false);
    await expect(h.controller.fire('nope')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(h.ticker.tick).not.toHaveBeenCalled();
  });

  it('runs one ticker round at the schedule\'s next fire and returns the tally', async () => {
    const h = build(true);
    const res = await h.controller.fire('s1');
    expect(h.repo.findById).toHaveBeenCalledWith('s1');
    expect(h.ticker.tick).toHaveBeenCalledWith(DUE);
    expect(res).toEqual(JsonResponse.Ok({ firedAt: DUE.toISOString(), result: RESULT }));
  });
});
