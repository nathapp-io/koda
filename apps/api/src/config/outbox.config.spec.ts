import { outboxConfig, IOutboxConfig } from './outbox.config';

describe('outboxConfig', () => {
  const saved = {
    NODE_ENV: process.env['NODE_ENV'],
    OUTBOX_RELAY_ENABLED: process.env['OUTBOX_RELAY_ENABLED'],
    OUTBOX_RETENTION_DAYS: process.env['OUTBOX_RETENTION_DAYS'],
  };

  const restore = (key: keyof typeof saved): void => {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    restore('NODE_ENV');
    restore('OUTBOX_RELAY_ENABLED');
    restore('OUTBOX_RETENTION_DAYS');
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

  it('accepts OUTBOX_RELAY_ENABLED case-insensitively (matches the Joi rule)', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['OUTBOX_RELAY_ENABLED'] = 'TRUE';
    expect(outboxConfig().relay.enabled).toBe(true);
  });

  it('rejects a non-boolean OUTBOX_RELAY_ENABLED', () => {
    process.env['OUTBOX_RELAY_ENABLED'] = 'yes';
    expect(() => outboxConfig()).toThrow();
  });

  it('defaults retention to 30 days outside tests', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['OUTBOX_RETENTION_DAYS'];
    expect(outboxConfig().retention).toEqual({ days: 30 });
  });

  it('disables retention under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['OUTBOX_RETENTION_DAYS'];
    expect(outboxConfig().retention).toEqual({ days: null });
  });

  it('OUTBOX_RETENTION_DAYS overrides the production default', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['OUTBOX_RETENTION_DAYS'] = '7';
    expect(outboxConfig().retention).toEqual({ days: 7 });
  });

  it('OUTBOX_RETENTION_DAYS re-enables retention under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['OUTBOX_RETENTION_DAYS'] = '14';
    expect(outboxConfig().retention).toEqual({ days: 14 });
  });

  it('OUTBOX_RETENTION_DAYS=0 is the kill switch', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['OUTBOX_RETENTION_DAYS'] = '0';
    expect(outboxConfig().retention).toEqual({ days: null });
  });

  it('rejects a non-numeric OUTBOX_RETENTION_DAYS', () => {
    process.env['OUTBOX_RETENTION_DAYS'] = 'weekly';
    expect(() => outboxConfig()).toThrow();
  });
});
