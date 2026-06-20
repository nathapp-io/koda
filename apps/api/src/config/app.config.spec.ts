import { appConfig, IAppConfig } from './app.config';

describe('appConfig', () => {
  beforeEach(() => {
    delete process.env['API_PORT'];
    delete process.env['API_HOST'];
    delete process.env['NODE_ENV'];
    delete process.env['GLOBAL_PREFIX'];
  });

  it('returns typed IAppConfig with defaults', () => {
    const cfg: IAppConfig = appConfig();
    expect(cfg.port).toBe(3100);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.globalPrefix).toBe('api');
  });

  it('reads API_HOST from env', () => {
    process.env['API_HOST'] = '127.0.0.1';
    const cfg: IAppConfig = appConfig();
    expect(cfg.host).toBe('127.0.0.1');
  });
});
