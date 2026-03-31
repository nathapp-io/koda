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

import { loginCommand } from './login';
import { agentsControllerFindMe } from '../generated';

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
