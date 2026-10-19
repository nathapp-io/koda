import { Reflector } from '@nestjs/core';
import { REQUIRES_METADATA, Requires, type RequiresMetadata } from './requires.decorator';

/**
 * US-001 — the `@Requires` route decorator and the metadata `RequiresGuard` reads.
 *
 * The decorator is the contract between a route and the guard, so the spec reads it back through
 * Nest's own `Reflector` instead of inspecting a private field: what a handler exposes here is
 * exactly what `getAllAndOverride(REQUIRES_METADATA, [handler, class])` returns at request time.
 */
class DecoratedController {
  undecorated(): void {}

  @Requires('ticket.read')
  ticketRead(): void {}

  @Requires(['ticket.update', 'ticket.assign'], { mode: 'any', enforcedBy: 'service' })
  ticketWrite(): void {}
}

const reflector = new Reflector();

/** The metadata a handler of `DecoratedController` exposes to the guard. */
function metadataOf(handler: () => void): RequiresMetadata | undefined {
  return reflector.getAllAndOverride<RequiresMetadata | undefined>(REQUIRES_METADATA, [handler, DecoratedController]);
}

describe('@Requires', () => {
  it('AC-1: a handler decorated with @Requires(\'ticket.read\') exposes exactly the default metadata', () => {
    expect(metadataOf(DecoratedController.prototype.ticketRead)).toEqual({
      keys: ['ticket.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
  });

  it('AC-22: Requires([]) throws an Error at decoration time', () => {
    expect(() => Requires([])).toThrow(Error);
  });

  it('records the options it was given', () => {
    expect(metadataOf(DecoratedController.prototype.ticketWrite)).toEqual({
      keys: ['ticket.update', 'ticket.assign'],
      mode: 'any',
      enforcedBy: 'service',
    });
  });

  it('leaves a handler without @Requires with no metadata', () => {
    expect(metadataOf(DecoratedController.prototype.undecorated)).toBeUndefined();
  });

  it('rejects an empty readonly key list as well', () => {
    const empty: readonly string[] = [];

    expect(() => Requires(empty)).toThrow(Error);
  });

  it('snapshots the key list, so mutating it later cannot change the route', () => {
    const keys = ['ticket.read'];
    class SnapshotController {
      @Requires(keys)
      handler(): void {}
    }
    keys.push('ticket.update');

    expect(metadataOf(SnapshotController.prototype.handler)?.keys).toEqual(['ticket.read']);
  });
});
