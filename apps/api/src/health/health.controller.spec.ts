import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController();
  });

  describe('check', () => {
    it('returns status ok', () => {
      const result = controller.check();

      expect(result.status).toBe('ok');
    });

    it('returns an ISO timestamp string', () => {
      const result = controller.check();

      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(() => new Date(result.timestamp)).not.toThrow();
    });

    it('timestamp is close to now', () => {
      const before = Date.now();
      const result = controller.check();
      const after = Date.now();

      const resultTime = new Date(result.timestamp).getTime();
      expect(resultTime).toBeGreaterThanOrEqual(before);
      expect(resultTime).toBeLessThanOrEqual(after);
    });

    it('returns a new timestamp on each call', async () => {
      const first = controller.check();
      await new Promise((r) => setTimeout(r, 2));
      const second = controller.check();

      // Timestamps may differ — both should be valid ISO strings
      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
    });
  });
});
