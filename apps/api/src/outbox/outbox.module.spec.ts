import { Test, TestingModule } from '@nestjs/testing';
import { OutboxFanOutRegistry } from './outbox-fan-out-registry';

/**
 * OutboxModule DI wiring tests
 *
 * Story: Register webhook delivery in OutboxModule fan-out
 *
 * Acceptance Criteria:
 * AC4: When a Nest testing module is constructed with OutboxFanOutRegistry as the sole provider
 *     and no other constructor arguments supplied, then compilation succeeds and
 *     module.get(OutboxFanOutRegistry) returns a defined instance.
 *
 * Rationale: this is a DI smoke test for the webhook_delivery constructor argument
 * (which is `@Optional()`), so OutboxFanOutRegistry must compile even with no
 * constructor arguments supplied by the testing module.
 */

describe('OutboxFanOutRegistry (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('AC4: Nest testing module with OutboxFanOutRegistry as the sole provider compiles and resolves a defined instance', async () => {
    moduleRef = await Test.createTestingModule({
      providers: [OutboxFanOutRegistry],
    }).compile();

    const registry = moduleRef.get(OutboxFanOutRegistry);
    expect(registry).toBeDefined();
    expect(registry).toBeInstanceOf(OutboxFanOutRegistry);
  });
});