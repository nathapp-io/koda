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

// Mock configureClient
jest.mock('../client', () => ({
  configureClient: jest.fn((baseUrl: string, apiKey: string) => {
    return {
      get: jest.fn(async () => {
        // Reject 'invalid' API key, allow others
        if (apiKey === 'invalid') {
          const error = new Error('Invalid API key') as unknown as Record<string, unknown>;
          error.response = { status: 401 };
          throw error;
        }
        return { status: 200, data: {} };
      }),
    };
  }),
}));

import { loginCommand } from './login';

describe('login command', () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => {
      delete mockData[key];
    });
    jest.clearAllMocks();
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
    await expect(
      loginCommand('invalid', 'http://example.com', {})
    ).rejects.toThrow();
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
      'http://localhost:3100/api'
    );
  });

  it('returns success message', async () => {
    const result = await loginCommand('sk-proj-test123456', 'http://example.com', {});
    expect(result).toEqual(expect.objectContaining({ success: true }));
  });
});
