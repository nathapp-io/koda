import { refreshClientOf } from './refresh-client';

describe('refreshClientOf', () => {
  it('hashes the user agent and retains the IP', () => {
    expect(refreshClientOf('Mozilla/5.0 X', '203.0.113.7')).toEqual({
      uaHash: '8a7c23ad74290bda29cc5187bbcacf71a0ec095faa3b6135ade3ba63271246b9',
      ip: '203.0.113.7',
    });
  });

  it('hashes an absent user agent and returns a null IP', () => {
    expect(refreshClientOf(undefined, undefined)).toEqual({
      uaHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ip: null,
    });
  });

  it('maps an empty IP to null', () => {
    expect(refreshClientOf('UA', '').ip).toBeNull();
  });
});
