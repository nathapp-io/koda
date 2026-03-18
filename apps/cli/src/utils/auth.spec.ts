// Mock conf before importing config module
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

jest.mock('../config');

import { resolveAuth } from './auth';
import * as config from '../config';

describe('auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;
  });

  describe('resolveAuth', () => {
    it('uses flag values when provided', () => {
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({
        apiKey: 'flag-key',
        apiUrl: 'http://flag.com',
      });

      expect(result.apiKey).toBe('flag-key');
      expect(result.apiUrl).toBe('http://flag.com');
    });

    it('uses env variables when flags not provided', () => {
      process.env.KODA_API_KEY = 'env-key';
      process.env.KODA_API_URL = 'http://env.com';
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({});

      expect(result.apiKey).toBe('env-key');
      expect(result.apiUrl).toBe('http://env.com');
    });

    it('uses config values when flags and env not provided', () => {
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({});

      expect(result.apiKey).toBe('config-key');
      expect(result.apiUrl).toBe('http://config.com');
    });

    it('uses default URL when nothing provided', () => {
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: '',
      });

      const result = resolveAuth({});

      expect(result.apiUrl).toBe('http://localhost:3100/api');
    });

    it('respects precedence: flag > env > config > default', () => {
      process.env.KODA_API_URL = 'http://env.com';
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({ apiUrl: 'http://flag.com' });

      expect(result.apiUrl).toBe('http://flag.com');
    });

    it('respects precedence: env > config > default when flag not provided', () => {
      process.env.KODA_API_URL = 'http://env.com';
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({});

      expect(result.apiUrl).toBe('http://env.com');
    });

    it('respects precedence: config > default when env not set', () => {
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({});

      expect(result.apiUrl).toBe('http://config.com');
    });

    it('returns partial auth when only one field provided', () => {
      (config.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'config-key',
        apiUrl: 'http://config.com',
      });

      const result = resolveAuth({ apiKey: 'flag-key' });

      expect(result.apiKey).toBe('flag-key');
      expect(result.apiUrl).toBe('http://config.com');
    });
  });
});
