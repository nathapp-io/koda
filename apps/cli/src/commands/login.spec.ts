// Mock conf before importing anything
const mockData: Record<string, string> = {};

const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => {
    mockData[key] = value;
  }),
};

jest.mock('conf', () => {
  return jest.fn(() => mockStore);
});

// Mock the generated client
jest.mock('../generated', () => ({
  agentsControllerFindMe: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

// Mock config module
jest.mock('../config', () => ({
  setConfig: jest.fn((partial: any) => {
    if (partial.apiKey) {
      mockData.apiKey = partial.apiKey;
      mockStore.set('apiKey', partial.apiKey);
    }
    if (partial.apiUrl) {
      mockData.apiUrl = partial.apiUrl;
      mockStore.set('apiUrl', partial.apiUrl);
    }
  }),
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
  })),
}));

import { loginCommand, loginError } from './login';
import { agentsControllerFindMe } from '../generated';
import { ApiError } from '../generated/core/ApiError';

describe('login command', () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => {
      delete mockData[key];
    });
    jest.clearAllMocks();
    // Default: agentsControllerFindMe succeeds
    (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: {} });
  });

  it('saves API key to config when provided', async () => {
    await loginCommand('sk-proj-test123456', 'http://example.com', {});
    expect(mockStore.set).toHaveBeenCalledWith('apiKey', 'sk-proj-test123456');
  });

  it('saves API URL to config when provided', async () => {
    await loginCommand('sk-proj-test123456', 'http://example.com', {});
    expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://example.com');
  });

  it('throws error when API key is invalid', async () => {
    (agentsControllerFindMe as jest.Mock).mockRejectedValue(new Error('Unauthorized'));
    await expect(
      loginCommand('invalid', 'http://example.com', {})
    ).rejects.toThrow();
  });

  function makeApiError(status: number, statusText: string, body: unknown): ApiError {
  return new ApiError(
    { method: 'GET', path: '/agents/me', headers: {} } as never,
    { body, ok: false, status, statusText, url: 'http://api.example.com' },
    statusText,
  );
}

describe('loginError — distinguishes auth failures from network and 5xx', () => {
    it('labels 401 as Invalid API key', () => {
      const err = makeApiError(401, 'Unauthorized', { message: 'Unauthorized' });
      const result = loginError(err);
      expect(result.message).toContain('Invalid API key');
      expect(result.status).toBe(401);
    });

    it('labels 403 as Invalid API key', () => {
      const err = makeApiError(403, 'Forbidden', { message: 'Forbidden' });
      const result = loginError(err);
      expect(result.message).toContain('Invalid API key');
      expect(result.status).toBe(403);
    });

    it('does not label 500 as Invalid API key', () => {
      const err = makeApiError(500, 'Server Error', { message: 'Upstream service unavailable' });
      const result = loginError(err);
      expect(result.message).not.toContain('Invalid API key');
      expect(result.status).toBe(500);
      expect(result.message).toContain('Upstream service unavailable');
    });

    it('flags network errors as transient so callers can retry', () => {
      const result = loginError(new Error('ECONNREFUSED 127.0.0.1:3100'));
      expect(result.message).toContain('Could not reach API');
      expect(result.transient).toBe(true);
    });

    it('handles unknown errors defensively', () => {
      const result = loginError('string error');
      expect(result.message).toContain('Could not reach API');
      expect(result.transient).toBe(true);
    });
  });

  it('surfaces 5xx instead of labeling it Invalid API key', async () => {
    const apiError = makeApiError(500, 'Server Error', { message: 'Database unavailable' });
    (agentsControllerFindMe as jest.Mock).mockRejectedValue(apiError);

    const caught = await loginCommand('sk-test-1234567890', 'http://api.example.com', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).not.toBeNull();
    expect((caught as Error).message).not.toContain('Invalid API key');
    expect((caught as Error).message).toContain('Database unavailable');
  });

  it('surfaces network errors instead of labeling them Invalid API key', async () => {
    (agentsControllerFindMe as jest.Mock).mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.example.com'));

    const caught = await loginCommand('sk-test-1234567890', 'http://api.example.com', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).not.toBeNull();
    expect((caught as Error).message).not.toContain('Invalid API key');
    expect((caught as Error).message).toContain('Could not reach API');
  });

  it('throws error when API key is not provided', async () => {
    await expect(
      loginCommand('', 'http://example.com', {})
    ).rejects.toThrow();
  });

  it('defaults to localhost API URL when not provided', async () => {
    await loginCommand('sk-proj-test123456', undefined, {});
    expect(mockStore.set).toHaveBeenCalledWith(
      'apiUrl',
      'http://localhost:3100'
    );
  });

  it('returns success message', async () => {
    const result = await loginCommand('sk-proj-test123456', 'http://example.com', {});
    expect(result).toEqual(expect.objectContaining({ success: true }));
  });
});
