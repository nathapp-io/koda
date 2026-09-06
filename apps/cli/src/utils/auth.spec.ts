// Mock config module to use mockData instead of real filesystem
jest.mock('../config', () => ({
  resolveContext: jest.fn().mockImplementation(async (flags: {
    apiKey?: string;
    apiUrl?: string;
  }) => ({
    projectSlug: undefined,
    apiKey: flags.apiKey ?? process.env.KODA_API_KEY ?? '',
    apiUrl: flags.apiUrl ?? process.env.KODA_API_URL ?? 'http://localhost:3100/api',
  })),
}));

import { resolveAuth } from './auth';

describe('resolveAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;
  });

  it('passes through flag values to resolveContext', async () => {
    const result = await resolveAuth({ apiKey: 'flag-key', apiUrl: 'http://flag.com' });
    expect(result.apiKey).toBe('flag-key');
    expect(result.apiUrl).toBe('http://flag.com');
  });

  it('falls back to env vars when no flags are provided', async () => {
    process.env.KODA_API_KEY = 'env-key';
    process.env.KODA_API_URL = 'http://env.com';

    const result = await resolveAuth({});
    expect(result.apiKey).toBe('env-key');
    expect(result.apiUrl).toBe('http://env.com');
  });

  it('falls back to the default URL when nothing is provided', async () => {
    const result = await resolveAuth({});
    expect(result.apiUrl).toBe('http://localhost:3100/api');
  });

  it('returns a promise that resolves to AuthResolution', async () => {
    const value = resolveAuth({ apiKey: 'k' });
    expect(value).toBeInstanceOf(Promise);
    const resolved = await value;
    expect(resolved).toHaveProperty('apiKey');
    expect(resolved).toHaveProperty('apiUrl');
  });
});
