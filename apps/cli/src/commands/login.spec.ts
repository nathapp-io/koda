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

// Keep the shared normalizer real while stubbing its presentation dependency.
jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    green: (value: string) => value,
    red: (value: string) => value,
    yellow: (value: string) => value,
    cyan: { bold: (value: string) => value },
    gray: (value: string) => value,
  },
}));

// Mock the generated client
jest.mock('../generated', () => ({
  agentsControllerFindMe: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../utils/secret-input', () => ({
  resolveSecret: jest.fn(async (value: string | boolean | undefined) =>
    typeof value === 'string' ? value : undefined,
  ),
  LOGIN_API_KEY_SECRET: {},
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

import { loginAction, loginCommand, loginError } from './login';
import { agentsControllerFindMe } from '../generated';
import { getStatusAndMessage } from '../utils/error';
import { setConfig } from '../config';

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

  // The generated client throws the parsed error body for HTTP failures.
  function makeApiError(status: number, statusText: string, body: unknown): unknown {
  return { ...(body as Record<string, unknown>), statusText, statusCode: status };
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

  it('saves the default URL when --api-url is an empty string', async () => {
    await loginCommand('sk-proj-test123456', '', {});
    expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://localhost:3100');
  });

  it('returns success message', async () => {
    const result = await loginCommand('sk-proj-test123456', 'http://example.com', {});
    expect(result).toEqual(expect.objectContaining({ success: true }));
  });

  it('AC-1: maps ret 40000 to Invalid API key with status 401 and no config writes', async () => {
    (agentsControllerFindMe as jest.Mock).mockRejectedValue({ ret: 40000, message: 'Unauthorized' });

    const caught = await loginCommand('invalid', 'http://example.com', {}).catch((error: unknown) => error);

    expect(caught).toMatchObject({ message: 'Invalid API key', status: 401 });
    expect(setConfig).not.toHaveBeenCalled();
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('AC-2: maps ret 40003 to Invalid API key with status 403 and no config writes', async () => {
    (agentsControllerFindMe as jest.Mock).mockRejectedValue({ ret: 40003, message: 'Forbidden' });

    const caught = await loginCommand('invalid', 'http://example.com', {}).catch((error: unknown) => error);

    expect(caught).toMatchObject({ message: 'Invalid API key', status: 403 });
    expect(setConfig).not.toHaveBeenCalled();
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('AC-3: retains legacy statusCode and message for other HTTP failures', async () => {
    (agentsControllerFindMe as jest.Mock).mockRejectedValue({ statusCode: 500, message: 'Server unavailable' });

    const caught = await loginCommand('key', 'http://example.com', {}).catch((error: unknown) => error);

    expect(caught).toMatchObject({ message: 'Server unavailable', status: 500 });
    expect((caught as { transient?: boolean }).transient).toBeUndefined();
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('AC-4: reports an unknown numeric API ret message without marking it transient', async () => {
    (agentsControllerFindMe as jest.Mock).mockRejectedValue({ ret: 49999, message: 'Policy rejected' });

    const caught = await loginCommand('key', 'http://example.com', {}).catch((error: unknown) => error);

    expect(caught).toMatchObject({ message: 'Policy rejected' });
    expect((caught as { transient?: boolean }).transient).toBeUndefined();
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('AC-5: preserves saved credentials for ECONNREFUSED transport failures', async () => {
    mockData.apiKey = 'previous-key';
    mockData.apiUrl = 'https://saved.example';
    const transport = Object.assign(new Error('ECONNREFUSED 127.0.0.1:3100'), { code: 'ECONNREFUSED' });
    (agentsControllerFindMe as jest.Mock).mockRejectedValue(transport);

    const caught = await loginCommand('replacement-key', 'http://example.com', {}).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      message: 'Could not reach API: ECONNREFUSED 127.0.0.1:3100',
      transient: true,
    });
    expect(mockData).toMatchObject({ apiKey: 'previous-key', apiUrl: 'https://saved.example' });
    expect(setConfig).not.toHaveBeenCalled();
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('AC-6: saves the supplied key and normalized endpoint exactly once on success', async () => {
    const result = await loginCommand('supplied-key', 'https://api.example/api/', {});

    expect(result.success).toBe(true);
    expect(setConfig).toHaveBeenCalledTimes(1);
    expect(setConfig).toHaveBeenCalledWith({ apiKey: 'supplied-key', apiUrl: 'https://api.example' });
    expect(mockStore.set).toHaveBeenCalledTimes(2);
  });

  it('AC-7: returns the established successful login message', async () => {
    await expect(loginCommand('supplied-key', 'https://api.example', {})).resolves.toEqual({
      success: true,
      message: 'Login successful. Credentials saved.',
    });
  });

  it('AC-8: login and shared normalizer prefer mapped ret 40000 over statusCode 500', async () => {
    const rejection = { ret: 40000, statusCode: 500, message: 'Unauthorized' };
    (agentsControllerFindMe as jest.Mock).mockRejectedValue(rejection);

    const caught = await loginCommand('invalid', 'http://example.com', {}).catch((error: unknown) => error);

    expect(getStatusAndMessage(rejection)).toEqual({ status: 401, message: 'Unauthorized' });
    expect(caught).toMatchObject({ message: 'Invalid API key', status: 401 });
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('AC-9: keeps the previously stored key when a mapped API rejection conflicts with legacy status', async () => {
    mockData.apiKey = 'previous-key';
    mockData.apiUrl = 'https://saved.example';
    (agentsControllerFindMe as jest.Mock).mockRejectedValue({
      ret: 40000,
      statusCode: 500,
      message: 'Unauthorized',
    });

    await expect(loginCommand('replacement-key', 'http://example.com', {})).rejects.toMatchObject({ status: 401 });

    expect(mockData.apiKey).toBe('previous-key');
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it('AC-10: API rejection does not overwrite saved credentials', async () => {
    mockData.apiKey = 'previous-key';
    mockData.apiUrl = 'https://saved.example';
    (agentsControllerFindMe as jest.Mock).mockRejectedValue({ ret: 40000, message: 'Unauthorized' });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(loginAction({ apiKey: 'replacement-key', apiUrl: 'http://example.com' }))
        .rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(errorSpy).toHaveBeenCalledWith('Error: Invalid API key');
      expect(mockData).toMatchObject({ apiKey: 'previous-key', apiUrl: 'https://saved.example' });
      expect(setConfig).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
