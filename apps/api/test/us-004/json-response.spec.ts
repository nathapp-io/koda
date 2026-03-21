/**
 * US-004 — JsonResponse class contract
 *
 * Tests the standard API response envelope: { data, meta?, message? }
 * These tests are RED until JsonResponse is fully implemented.
 */
import { JsonResponse } from '/nestjs-common';

describe('JsonResponse', () => {
  describe('JsonResponse.ok()', () => {
    it('returns an instance of JsonResponse', () => {
      const result = JsonResponse.ok({ id: '1', name: 'Test' });
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps data under the data key', () => {
      const payload = { id: '1', name: 'Test' };
      const result = JsonResponse.ok(payload);
      expect(result.data).toEqual(payload);
    });

    it('does not include meta when not provided', () => {
      const result = JsonResponse.ok({ id: '1' });
      expect(result.meta).toBeUndefined();
    });

    it('does not include message when not provided', () => {
      const result = JsonResponse.ok({ id: '1' });
      expect(result.message).toBeUndefined();
    });

    it('works with array data', () => {
      const items = [{ id: '1' }, { id: '2' }];
      const result = JsonResponse.ok(items);
      expect(result.data).toEqual(items);
    });
  });

  describe('JsonResponse.created()', () => {
    it('returns an instance of JsonResponse', () => {
      const result = JsonResponse.created({ id: '1', name: 'Test' });
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps data under the data key', () => {
      const payload = { id: '1', name: 'Test' };
      const result = JsonResponse.created(payload);
      expect(result.data).toEqual(payload);
    });

    it('does not include meta when not provided', () => {
      const result = JsonResponse.created({ id: '1' });
      expect(result.meta).toBeUndefined();
    });
  });

  describe('JsonResponse.paginated()', () => {
    it('returns an instance of JsonResponse', () => {
      const meta = { total: 10, page: 1, limit: 5 };
      const result = JsonResponse.paginated([{ id: '1' }], meta);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps array under the data key', () => {
      const items = [{ id: '1' }, { id: '2' }];
      const meta = { total: 2, page: 1, limit: 10 };
      const result = JsonResponse.paginated(items, meta);
      expect(result.data).toEqual(items);
    });

    it('includes meta with pagination info', () => {
      const meta = { total: 10, page: 1, limit: 5 };
      const result = JsonResponse.paginated([], meta);
      expect(result.meta).toEqual(meta);
    });

    it('meta contains total, page, and limit fields', () => {
      const meta = { total: 42, page: 3, limit: 10 };
      const result = JsonResponse.paginated([], meta);
      expect(result.meta).toHaveProperty('total', 42);
      expect(result.meta).toHaveProperty('page', 3);
      expect(result.meta).toHaveProperty('limit', 10);
    });
  });

  describe('response envelope shape', () => {
    it('ok result has { data } shape', () => {
      const result = JsonResponse.ok({ id: '1' });
      expect(Object.keys(result)).toContain('data');
    });

    it('paginated result has { data, meta } shape', () => {
      const result = JsonResponse.paginated([], { total: 0, page: 1, limit: 10 });
      expect(Object.keys(result)).toContain('data');
      expect(Object.keys(result)).toContain('meta');
    });
  });
});
