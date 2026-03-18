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

import { configShow, configSet } from './config';

describe('config command', () => {
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => {
      delete mockData[key];
    });
    jest.clearAllMocks();
    mockData.apiKey = 'sk-proj-test123456';
    mockData.apiUrl = 'http://example.com';
  });

  describe('configShow', () => {
    it('returns config object with masked API key', () => {
      const result = configShow();
      expect(result).toEqual(
        expect.objectContaining({
          apiKey: expect.stringMatching(/^sk-proj-\*+$/),
          apiUrl: 'http://example.com',
        })
      );
    });

    it('displays API key prefix in masked version', () => {
      const result = configShow();
      const maskedKey = result.apiKey;
      expect(maskedKey).toMatch(/^sk-proj-\*+/);
    });

    it('returns empty string for apiUrl when not set', () => {
      mockData.apiUrl = '';
      const result = configShow();
      expect(result.apiUrl).toBe('');
    });

    it('masks API key with first 8 chars visible', () => {
      mockData.apiKey = 'sk-proj-verylongapikey1234567890';
      const result = configShow();
      expect(result.apiKey).toMatch(/^sk-proj-\*+/);
    });
  });

  describe('configSet', () => {
    it('updates API key when provided', () => {
      configSet({ apiKey: 'sk-proj-newkey123456' });
      expect(mockStore.set).toHaveBeenCalledWith('apiKey', 'sk-proj-newkey123456');
    });

    it('updates API URL when provided', () => {
      configSet({ apiUrl: 'http://newapi.com' });
      expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://newapi.com');
    });

    it('updates both when both provided', () => {
      configSet({
        apiKey: 'sk-proj-newkey123456',
        apiUrl: 'http://newapi.com',
      });
      expect(mockStore.set).toHaveBeenCalledWith('apiKey', 'sk-proj-newkey123456');
      expect(mockStore.set).toHaveBeenCalledWith('apiUrl', 'http://newapi.com');
    });

    it('throws error when API key is invalid', () => {
      expect(() => {
        configSet({ apiKey: 'invalid' });
      }).toThrow();
    });

    it('returns success message', () => {
      const result = configSet({ apiKey: 'sk-proj-newkey123456' });
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });
  });
});
