import { outboxConfig, IOutboxConfig } from './outbox.config';

describe('outboxConfig', () => {
  const saved = {
    NODE_ENV: process.env['NODE_ENV'],
    OUTBOX_RELAY_ENABLED: process.env['OUTBOX_RELAY_ENABLED'],
  };

  const restore = (key: keyof typeof saved): void => {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    restore('NODE_ENV');
    restore('OUTBOX_RELAY_ENABLED');
  });

  it('uses the slice-2 relay settings', () => {
    const cfg: IOutboxConfig = outboxConfig();
    expect(cfg.relay).toMatchObject({
      pollIntervalMs: 1000,
      batchSize: 20,
      leaseMs: 30000,
      maxAttempts: 8,
      backoffBaseMs: 2000,
      backoffCapMs: 300000,
    });
  });

  it('enables the relay outside tests', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['OUTBOX_RELAY_ENABLED'];
    expect(outboxConfig().relay.enabled).toBe(true);
  });

  it('disables the relay under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['OUTBOX_RELAY_ENABLED'];
    expect(outboxConfig().relay.enabled).toBe(false);
  });

  it('OUTBOX_RELAY_ENABLED=true overrides NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['OUTBOX_RELAY_ENABLED'] = 'true';
    expect(outboxConfig().relay.enabled).toBe(true);
  });

  it('OUTBOX_RELAY_ENABLED=false disables the relay in production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['OUTBOX_RELAY_ENABLED'] = 'false';
    expect(outboxConfig().relay.enabled).toBe(false);
  });

  it('rejects a non-boolean OUTBOX_RELAY_ENABLED', () => {
    process.env['OUTBOX_RELAY_ENABLED'] = 'yes';
    expect(() => outboxConfig()).toThrow();
  });
});
