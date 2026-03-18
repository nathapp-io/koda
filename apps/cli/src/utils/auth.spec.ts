import { resolveAuth } from './auth';
import * as configModule from '../config';

jest.mock('../config');

describe('resolveAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;
  });

  describe('apiKey resolution', () => {
    it('prefers --api-key flag over environment and config', () => {
      const mockConfig = { apiKey: 'config-key', apiUrl: 'http://localhost:3100/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);
      process.env.KODA_API_KEY = 'env-key';

      const result = resolveAuth({ apiKey: 'flag-key' });

      expect(result.apiKey).toBe('flag-key');
    });

    it('falls back to KODA_API_KEY env when flag is not provided', () => {
      const mockConfig = { apiKey: 'config-key', apiUrl: 'http://localhost:3100/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);
      process.env.KODA_API_KEY = 'env-key';

      const result = resolveAuth({});

      expect(result.apiKey).toBe('env-key');
    });

    it('falls back to config file when flag and env are not provided', () => {
      const mockConfig = { apiKey: 'config-key', apiUrl: 'http://localhost:3100/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);

      const result = resolveAuth({});

      expect(result.apiKey).toBe('config-key');
    });

    it('returns undefined when all three sources are missing', () => {
      const mockConfig = { apiUrl: 'http://localhost:3100/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);

      const result = resolveAuth({});

      expect(result.apiKey).toBeUndefined();
    });
  });

  describe('apiUrl resolution', () => {
    it('prefers --api-url flag over environment and config', () => {
      const mockConfig = { apiUrl: 'http://config:3000/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);
      process.env.KODA_API_URL = 'http://env:3000/api';

      const result = resolveAuth({ apiUrl: 'http://flag:3000/api' });

      expect(result.apiUrl).toBe('http://flag:3000/api');
    });

    it('falls back to KODA_API_URL env when flag is not provided', () => {
      const mockConfig = { apiUrl: 'http://config:3000/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);
      process.env.KODA_API_URL = 'http://env:3000/api';

      const result = resolveAuth({});

      expect(result.apiUrl).toBe('http://env:3000/api');
    });

    it('falls back to config file when flag and env are not provided', () => {
      const mockConfig = { apiUrl: 'http://config:3000/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);

      const result = resolveAuth({});

      expect(result.apiUrl).toBe('http://config:3000/api');
    });

    it('defaults to http://localhost:3100/api when all sources are missing', () => {
      const mockConfig = {};
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);

      const result = resolveAuth({});

      expect(result.apiUrl).toBe('http://localhost:3100/api');
    });
  });

  describe('combined resolution', () => {
    it('returns both apiKey and apiUrl from different sources', () => {
      const mockConfig = { apiUrl: 'http://config:3000/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);
      process.env.KODA_API_KEY = 'env-key';

      const result = resolveAuth({ apiUrl: 'http://flag:3000/api' });

      expect(result.apiKey).toBe('env-key');
      expect(result.apiUrl).toBe('http://flag:3000/api');
    });

    it('returns object with both apiKey and apiUrl properties', () => {
      const mockConfig = { apiKey: 'config-key', apiUrl: 'http://localhost:3100/api' };
      (configModule.getConfig as jest.Mock).mockReturnValue(mockConfig);

      const result = resolveAuth({});

      expect(result).toHaveProperty('apiKey');
      expect(result).toHaveProperty('apiUrl');
    });
  });
});
