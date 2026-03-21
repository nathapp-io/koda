/**
 * US-004 — JsonResponse class contract (v3 @nathapp/nestjs-common)
 *
 * Tests the standard API response envelope: { ret, data, message? }
 * v3 exposes JsonResponse.Ok(data) and JsonResponse.Error(code, message).
 */
import { JsonResponse } from '@nathapp/nestjs-common';

describe('JsonResponse', () => {
  describe('JsonResponse.Ok()', () => {
    it('returns an instance of JsonResponse', () => {
      const result = JsonResponse.Ok({ id: '1', name: 'Test' });
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps data under the data key', () => {
      const payload = { id: '1', name: 'Test' };
      const result = JsonResponse.Ok(payload);
      expect(result.data).toEqual(payload);
    });

    it('sets ret to 0 for success', () => {
      const result = JsonResponse.Ok({ id: '1' });
      expect(result.ret).toBe(0);
    });

    it('does not include message when not provided', () => {
      const result = JsonResponse.Ok({ id: '1' });
      expect(result.message).toBeUndefined();
    });

    it('works with array data', () => {
      const items = [{ id: '1' }, { id: '2' }];
      const result = JsonResponse.Ok(items);
      expect(result.data).toEqual(items);
    });

    it('works with undefined data', () => {
      const result = JsonResponse.Ok(undefined);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('JsonResponse.Error()', () => {
    it('returns an instance of JsonResponse', () => {
      const result = JsonResponse.Error(404, 'Not Found');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('sets the error code', () => {
      const result = JsonResponse.Error(404, 'Not Found');
      expect(result.ret).toBe(404);
    });

    it('sets the error message', () => {
      const result = JsonResponse.Error(500, 'Internal Server Error');
      expect(result.message).toBe('Internal Server Error');
    });
  });

  describe('response envelope shape', () => {
    it('Ok result has { ret, data } shape', () => {
      const result = JsonResponse.Ok({ id: '1' });
      expect(result).toHaveProperty('ret');
      expect(result).toHaveProperty('data');
    });

    it('Error result has { ret, message } shape', () => {
      const result = JsonResponse.Error(404, 'Not Found');
      expect(result).toHaveProperty('ret');
      expect(result).toHaveProperty('message');
    });
  });
});
