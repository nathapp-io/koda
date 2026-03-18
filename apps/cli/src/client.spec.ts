import axios, { AxiosInstance } from 'axios';
import { configureClient } from './client';

jest.mock('axios');

describe('Client Configuration', () => {
  const mockAxiosCreate = axios.create as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosCreate.mockReturnValue({
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
      defaults: { headers: { common: {} } },
    } as unknown as AxiosInstance);
  });

  describe('configureClient()', () => {
    describe('client creation', () => {
      it('creates an axios instance', () => {
        configureClient('http://localhost:3100/api', 'test-token');

        expect(axios.create).toHaveBeenCalled();
      });

      it('returns configured axios instance', () => {
        const mockClient = {
          defaults: { baseURL: '' },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(mockClient);

        const result = configureClient('http://localhost:3100/api', 'test-token');

        expect(result).toBeDefined();
      });
    });

    describe('baseURL configuration', () => {
      it('sets baseURL from provided apiUrl parameter', () => {
        const apiUrl = 'http://api.example.com/api';
        const client = {
          defaults: { baseURL: '' },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient(apiUrl, 'token');

        // baseURL should be set either via defaults or config object
        expect(client.defaults.baseURL).toBe(apiUrl);
      });

      it('handles apiUrl with trailing slash', () => {
        const apiUrl = 'http://api.example.com/api/';
        const client = {
          defaults: { baseURL: '' },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient(apiUrl, 'token');

        // Should handle trailing slash correctly
        expect(client.defaults.baseURL).toBeDefined();
      });

      it('handles apiUrl without protocol', () => {
        const apiUrl = 'localhost:3100/api';

        configureClient(apiUrl, 'token');

        expect(axios.create).toHaveBeenCalled();
      });

      it('handles different protocols (http, https)', () => {
        const httpUrl = 'http://localhost:3100/api';
        const httpsUrl = 'https://api.example.com/api';

        configureClient(httpUrl, 'token');
        jest.clearAllMocks();

        configureClient(httpsUrl, 'token');

        expect(axios.create).toHaveBeenCalledTimes(1);
      });
    });

    describe('Bearer token configuration', () => {
      it('configures Authorization header with Bearer token', () => {
        const token = 'test-api-token-12345';
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', token);

        // Token should be set in Authorization header
        expect(client.defaults.headers.common['Authorization']).toContain('Bearer');
        expect(client.defaults.headers.common['Authorization']).toContain(token);
      });

      it('formats Bearer token correctly (Bearer <token>)', () => {
        const token = 'my-secret-key';
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', token);

        expect(client.defaults.headers.common['Authorization']).toBe(`Bearer ${token}`);
      });

      it('handles empty token string', () => {
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', '');

        expect(client.defaults.headers.common['Authorization']).toBe('Bearer ');
      });

      it('overwrites existing Authorization header', () => {
        const client = {
          defaults: {
            headers: { common: { 'Authorization': 'Bearer old-token' } },
          },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', 'new-token');

        expect(client.defaults.headers.common['Authorization']).toBe('Bearer new-token');
      });
    });

    describe('client configuration object', () => {
      it('passes configuration to axios.create()', () => {
        const apiUrl = 'http://localhost:3100/api';
        const token = 'test-token';

        configureClient(apiUrl, token);

        expect(axios.create).toHaveBeenCalledWith(
          expect.objectContaining({
            baseURL: apiUrl,
            headers: expect.objectContaining({
              common: expect.objectContaining({
                Authorization: `Bearer ${token}`,
              }),
            }),
          })
        );
      });

      it('includes all required configuration options', () => {
        configureClient('http://localhost:3100/api', 'token');

        const callArgs = mockAxiosCreate.mock.calls[0][0];
        expect(callArgs).toHaveProperty('baseURL');
        expect(callArgs).toHaveProperty('headers');
      });
    });

    describe('different token types', () => {
      it('handles API keys as bearer tokens', () => {
        const apiKey = 'sk_live_1234567890abcdef';
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', apiKey);

        expect(client.defaults.headers.common['Authorization']).toBe(
          `Bearer ${apiKey}`
        );
      });

      it('handles JWT tokens', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', jwt);

        expect(client.defaults.headers.common['Authorization']).toBe(
          `Bearer ${jwt}`
        );
      });

      it('handles long tokens', () => {
        const longToken = 'a'.repeat(500);
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', longToken);

        expect(client.defaults.headers.common['Authorization']).toBe(
          `Bearer ${longToken}`
        );
      });
    });

    describe('multiple configurations', () => {
      it('can be called multiple times with different credentials', () => {
        const client1 = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        const client2 = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;

        mockAxiosCreate.mockReturnValueOnce(client1).mockReturnValueOnce(client2);

        configureClient('http://localhost:3100/api', 'token1');
        configureClient('http://different:3100/api', 'token2');

        expect(axios.create).toHaveBeenCalledTimes(2);
      });

      it('each client is independent', () => {
        const client1 = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        const client2 = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;

        mockAxiosCreate.mockReturnValueOnce(client1).mockReturnValueOnce(client2);

        configureClient('http://api1.com', 'token1');
        configureClient('http://api2.com', 'token2');

        expect(client1.defaults.headers.common['Authorization']).toBe('Bearer token1');
        expect(client2.defaults.headers.common['Authorization']).toBe('Bearer token2');
      });
    });

    describe('error handling', () => {
      it('handles axios.create throwing an error', () => {
        mockAxiosCreate.mockImplementation(() => {
          throw new Error('Failed to create client');
        });

        expect(() => {
          configureClient('http://localhost:3100/api', 'token');
        }).toThrow();
      });

      it('handles undefined apiUrl gracefully', () => {
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        // Should not throw even with undefined apiUrl
        expect(() => {
          configureClient(undefined as any, 'token');
        }).not.toThrow();
      });

      it('handles undefined token gracefully', () => {
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        expect(() => {
          configureClient('http://localhost:3100/api', undefined as any);
        }).not.toThrow();
      });
    });

    describe('compatibility with hey-api client', () => {
      it('returns a client compatible with @hey-api/client-axios', () => {
        const client = {
          defaults: { baseURL: '', headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
          get: jest.fn(),
          post: jest.fn(),
          put: jest.fn(),
          delete: jest.fn(),
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        const result = configureClient('http://localhost:3100/api', 'token');

        expect(result).toHaveProperty('get');
        expect(result).toHaveProperty('post');
        expect(result).toHaveProperty('put');
        expect(result).toHaveProperty('delete');
      });

      it('configured client can make requests', () => {
        const mockGet = jest.fn();
        const client = {
          defaults: { baseURL: '', headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
          get: mockGet,
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        const configured = configureClient('http://localhost:3100/api', 'token');
        if (configured?.get) {
          configured.get('/endpoint');
        }

        expect(mockGet).toHaveBeenCalled();
      });
    });

    describe('real-world scenarios', () => {
      it('works with local development setup', () => {
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('http://localhost:3100/api', 'dev-token');

        expect(client.defaults.headers.common['Authorization']).toBe('Bearer dev-token');
      });

      it('works with production setup', () => {
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('https://api.example.com/api', 'prod-token');

        expect(client.defaults.headers.common['Authorization']).toBe('Bearer prod-token');
      });

      it('works with custom domain setup', () => {
        const client = {
          defaults: { headers: { common: {} } },
          interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
        } as unknown as AxiosInstance;
        mockAxiosCreate.mockReturnValue(client);

        configureClient('https://custom.internal.company.com:8443/api', 'internal-token');

        expect(client.defaults.headers.common['Authorization']).toBe(
          'Bearer internal-token'
        );
      });
    });
  });
});
