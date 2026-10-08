import { notificationsConfig } from './notifications.config';
import { validate } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 's',
  JWT_REFRESH_SECRET: 'r',
  API_KEY_SECRET: 'k',
};

describe('notificationsConfig (S4a D511)', () => {
  const saved = { days: process.env['NOTIFICATION_RETENTION_DAYS'], env: process.env['NODE_ENV'] };

  afterEach(() => {
    if (saved.days === undefined) delete process.env['NOTIFICATION_RETENTION_DAYS'];
    else process.env['NOTIFICATION_RETENTION_DAYS'] = saved.days;
    process.env['NODE_ENV'] = saved.env;
  });

  it('defaults to 90 days outside tests and to off under NODE_ENV=test', () => {
    delete process.env['NOTIFICATION_RETENTION_DAYS'];
    process.env['NODE_ENV'] = 'production';
    expect(notificationsConfig()).toEqual({ retentionDays: 90 });
    process.env['NODE_ENV'] = 'test';
    expect(notificationsConfig()).toEqual({ retentionDays: null });
  });

  it('reads an override; 0 switches the purge off', () => {
    process.env['NOTIFICATION_RETENTION_DAYS'] = '30';
    expect(notificationsConfig().retentionDays).toBe(30);
    process.env['NOTIFICATION_RETENTION_DAYS'] = '0';
    expect(notificationsConfig().retentionDays).toBeNull();
  });

  it.each(['-1', '1.5', 'abc'])('refuses NOTIFICATION_RETENTION_DAYS=%s', (value) => {
    process.env['NOTIFICATION_RETENTION_DAYS'] = value;
    expect(() => notificationsConfig()).toThrow();
    expect(() => validate({ ...REQUIRED, NOTIFICATION_RETENTION_DAYS: value })).toThrow();
    expect(() => validate({ ...REQUIRED, NOTIFICATION_RETENTION_DAYS: '30' })).not.toThrow();
  });
});
