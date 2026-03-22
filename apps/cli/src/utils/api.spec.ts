import { unwrap } from './api';

describe('unwrap', () => {
  describe('returns inner data when ret === 0', () => {
    it('unwraps a single object', () => {
      const response = { data: { ret: 0, data: { id: '1', name: 'Test' } } };
      expect(unwrap(response)).toEqual({ id: '1', name: 'Test' });
    });

    it('unwraps an array', () => {
      const response = { data: { ret: 0, data: [1, 2, 3] } };
      expect(unwrap(response)).toEqual([1, 2, 3]);
    });

    it('unwraps a list shape with items and total', () => {
      const items = [{ id: 'a' }, { id: 'b' }];
      const response = { data: { ret: 0, data: { items, total: 2 } } };
      expect(unwrap(response)).toEqual({ items, total: 2 });
    });

    it('unwraps null data', () => {
      const response = { data: { ret: 0, data: null } };
      expect(unwrap(response)).toBeNull();
    });
  });

  describe('throws when ret !== 0', () => {
    it('throws on ret = 1', () => {
      const response = { data: { ret: 1, data: null } };
      expect(() => unwrap(response)).toThrow();
    });

    it('throws on non-zero ret with a message', () => {
      const response = { data: { ret: 42, data: null } };
      expect(() => unwrap(response)).toThrow(/ret=42/);
    });

    it('throws on negative ret', () => {
      const response = { data: { ret: -1, data: null } };
      expect(() => unwrap(response)).toThrow();
    });
  });
});
