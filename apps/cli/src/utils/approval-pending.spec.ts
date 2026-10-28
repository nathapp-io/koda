const mockResponseInterceptors: Array<(response: Response) => Promise<Response>> = [];
const mockSetConfig = jest.fn();

jest.mock('../generated/client.gen', () => ({
  client: {
    setConfig: mockSetConfig,
    interceptors: { response: { use: (fn: (response: Response) => Promise<Response>) => mockResponseInterceptors.push(fn) } },
  },
}));

import { client } from '../generated/client.gen';
import { configureApiClient } from './api-client';
import { ApprovalPendingError } from './approval-pending';

const request = {
  id: 'r1',
  permissionKey: 'role.manage',
  requiredMode: 'human',
  status: 'pending',
  expiresAt: '2026-11-09T00:00:00.000Z',
};

describe('approval pending response handling', () => {
  beforeEach(() => {
    mockSetConfig.mockClear();
  });

  it('AC-1: rejects a 202 response with ApprovalPendingError', async () => {
    configureApiClient('https://api.example.test');
    const response = mockResponseInterceptors[0](new Response(JSON.stringify({ ret: 0, data: request }), { status: 202 }));
    const error = await response.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApprovalPendingError);
    expect((error as ApprovalPendingError).request.id).toBe('r1');
  });

  it('AC-2: returns a 200 response unchanged', async () => {
    configureApiClient('https://api.example.test');
    const original = new Response('{"ok":true}', { status: 200 });
    await expect(mockResponseInterceptors[0](original)).resolves.toBe(original);
  });

  it('AC-3: installs one response interceptor across repeated configuration', () => {
    configureApiClient('https://api.example.test');
    configureApiClient('https://api.example.test/other', 'key');
    expect(client.interceptors.response).toBeDefined();
    expect(mockResponseInterceptors).toHaveLength(1);
    expect(mockSetConfig).toHaveBeenCalledTimes(2);
  });

  it('AC-8: ApprovalPendingError is an Error with the request id in its message', () => {
    const error = new ApprovalPendingError(request);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('approval pending: r1');
    expect(error.request).toEqual(request);
  });
});
