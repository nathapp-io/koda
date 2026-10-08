import { Logger } from '@nestjs/common';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../../test/helpers/outbox-record';
import { FleetHealthAlertSubscriber } from './fleet-health-alert.subscriber';

describe('FleetHealthAlertSubscriber (S4a §2.4)', () => {
  const writer = { deliver: jest.fn(async () => 1) };
  const eligibility = { findGlobalAdminIds: jest.fn(async () => ['a1']) };
  let registry: FanOutPublisher;

  beforeEach(() => {
    registry = new FanOutPublisher(noopLastErrors);
    new FleetHealthAlertSubscriber(registry, eligibility as never, writer as never).onModuleInit();
  });
  afterEach(() => jest.clearAllMocks());

  it('delivers the alert to every global admin', async () => {
    await registry.publish(outboxRecord('fleet_health_alert', { alertId: 'al1', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null }));
    expect(writer.deliver).toHaveBeenCalledWith([expect.objectContaining({ userId: 'a1', kind: 'runner_offline', sourceId: 'al1', projectId: null })]);
  });

  it('skips a malformed payload without retrying', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(registry.publish(outboxRecord('fleet_health_alert', { alertId: 'al1', kind: 'nope' }))).resolves.toBeUndefined();
    expect(writer.deliver).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
