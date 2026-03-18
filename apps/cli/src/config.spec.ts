import Conf from 'conf';
import { getConfig, setConfig } from './config';

jest.mock('conf');

describe('Config Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getConfig', () => {
    it('returns config object with apiKey and apiUrl', () => {
      const mockConfigInstance = {
        store: {
          apiKey: 'test-key',
          apiUrl: 'http://localhost:3100/api',
        },
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      const config = getConfig();

      expect(config).toHaveProperty('apiKey', 'test-key');
      expect(config).toHaveProperty('apiUrl', 'http://localhost:3100/api');
    });

    it('returns empty object when config is empty', () => {
      const mockConfigInstance = {
        store: {},
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      const config = getConfig();

      expect(config).toEqual({});
    });

    it('returns object with only apiKey when apiUrl is not set', () => {
      const mockConfigInstance = {
        store: {
          apiKey: 'test-key',
        },
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      const config = getConfig();

      expect(config).toEqual({ apiKey: 'test-key' });
      expect(config.apiUrl).toBeUndefined();
    });

    it('returns object with only apiUrl when apiKey is not set', () => {
      const mockConfigInstance = {
        store: {
          apiUrl: 'http://localhost:3100/api',
        },
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      const config = getConfig();

      expect(config).toEqual({ apiUrl: 'http://localhost:3100/api' });
      expect(config.apiKey).toBeUndefined();
    });

    it('creates Conf instance with correct options for ~/.koda/config.json', () => {
      getConfig();

      expect(Conf).toHaveBeenCalledWith(
        expect.objectContaining({
          configName: 'config',
          cwd: expect.stringContaining('.koda'),
        })
      );
    });
  });

  describe('setConfig', () => {
    it('updates apiKey in config', () => {
      const mockConfigInstance = {
        set: jest.fn(),
        store: { apiKey: 'old-key', apiUrl: 'http://localhost:3100/api' },
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      setConfig({ apiKey: 'new-key' });

      expect(mockConfigInstance.set).toHaveBeenCalledWith('apiKey', 'new-key');
    });

    it('updates apiUrl in config', () => {
      const mockConfigInstance = {
        set: jest.fn(),
        store: { apiKey: 'test-key', apiUrl: 'http://localhost:3100/api' },
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      setConfig({ apiUrl: 'http://custom:3100/api' });

      expect(mockConfigInstance.set).toHaveBeenCalledWith('apiUrl', 'http://custom:3100/api');
    });

    it('updates both apiKey and apiUrl in single call', () => {
      const mockConfigInstance = {
        set: jest.fn(),
        store: {},
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      setConfig({ apiKey: 'new-key', apiUrl: 'http://custom:3100/api' });

      expect(mockConfigInstance.set).toHaveBeenCalledTimes(2);
      expect(mockConfigInstance.set).toHaveBeenCalledWith('apiKey', 'new-key');
      expect(mockConfigInstance.set).toHaveBeenCalledWith('apiUrl', 'http://custom:3100/api');
    });

    it('does not call set when no properties are provided', () => {
      const mockConfigInstance = {
        set: jest.fn(),
        store: { apiKey: 'test-key', apiUrl: 'http://localhost:3100/api' },
      };
      (Conf as jest.Mock).mockReturnValue(mockConfigInstance);

      setConfig({});

      expect(mockConfigInstance.set).not.toHaveBeenCalled();
    });
  });
});
