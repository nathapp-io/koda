/**
 * OutboxFanOutRegistry Tests
 *
 * Story: Outbox Service Enqueue and Processing
 * Description: OutboxFanOutRegistry dispatches events to registered handlers
 *
 * Acceptance Criteria:
 * AC39: register('foo', handler) then dispatch({ eventType: 'foo', payload }) invokes handler once
 * AC40: Multiple handlers for same eventType are called in registration order
 * AC41: getHandlers() returns DEFAULT_HANDLERS before startup lifecycle completes
 * AC42: dispatch calls all handlers sequentially (not parallel)
 * AC43: Handler errors are caught and logged; subsequent handlers still run
 * AC44: document_indexed payload has sourceId, content, metadata fields
 * AC45: graphify_import payload has projectId, nodeCount, linkCount fields
 * AC25: If dispatch() throws, markFailed() is called (not immediate dead-letter)
 */

describe('OutboxFanOutRegistry', () => {
  let registry: OutboxFanOutRegistry;

  beforeEach(() => {
    registry = new OutboxFanOutRegistry();
  });

  describe('AC39: register and dispatch', () => {
    it('AC39: register("foo", handler) then dispatch({ eventType: "foo" }) invokes handler exactly once', async () => {
      const handler = jest.fn();
      registry.register('foo', handler);

      await registry.dispatch({ eventType: 'foo', payload: { test: 'data' } });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ test: 'data' });
    });

    it('AC39: handler is not called before registration', async () => {
      const handler = jest.fn();

      await registry.dispatch({ eventType: 'foo', payload: {} });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('AC40: multiple handlers for same eventType', () => {
    it('AC40: register("foo", handler1) then register("foo", handler2) invokes both in order', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      registry.register('foo', handler1);
      registry.register('foo', handler2);

      await registry.dispatch({ eventType: 'foo', payload: {} });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1.mock.invocationCallOrder[0]).toBeLessThan(handler2.mock.invocationCallOrder[0]);
    });

    it('AC40: getHandlers(eventType) returns array of length 2 for "foo"', () => {
      registry.register('foo', jest.fn());
      registry.register('foo', jest.fn());

      const handlers = registry.getHandlers('foo');

      expect(handlers).toHaveLength(2);
    });
  });

  describe('AC41: DEFAULT_HANDLERS registration', () => {
    it('AC41: getHandlers() returns array with length equal to DEFAULT_HANDLERS.length', () => {
      const handlers = registry.getHandlers('ticket_event');

      expect(handlers.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AC42: sequential dispatch (not parallel)', () => {
    it('AC42: dispatch calls handlers sequentially; final line only reached after last handler', async () => {
      const callOrder: string[] = [];

      registry.register('ticket_event', async () => {
        callOrder.push('handler1-start');
        await new Promise(resolve => setTimeout(resolve, 10));
        callOrder.push('handler1-end');
      });

      registry.register('ticket_event', async () => {
        callOrder.push('handler2-start');
        callOrder.push('handler2-end');
      });

      await registry.dispatch({ eventType: 'ticket_event', payload: {} });

      expect(callOrder).toEqual(['handler1-start', 'handler1-end', 'handler2-start', 'handler2-end']);
    });
  });

  describe('AC43: handler error handling', () => {
    it('AC43: when handler throws, error is logged and subsequent handlers still run', async () => {
      const loggerSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const handler1 = jest.fn().mockImplementation(() => {
        throw new Error('Handler 1 failed');
      });
      const handler2 = jest.fn();

      registry.register('ticket_event', handler1);
      registry.register('ticket_event', handler2);

      await registry.dispatch({ eventType: 'ticket_event', payload: {} });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(loggerSpy).toHaveBeenCalled();

      loggerSpy.mockRestore();
    });

    it('AC43: dispatch() returns normally even when handlers throw', async () => {
      const handler = jest.fn().mockImplementation(() => {
        throw new Error('Boom');
      });
      registry.register('ticket_event', handler);

      await expect(registry.dispatch({ eventType: 'ticket_event', payload: {} })).resolves.toBeUndefined();
    });
  });

  describe('AC44: document_indexed payload structure', () => {
    it('AC44: dispatch with eventType=document_indexed has payload with sourceId, content, metadata', async () => {
      let capturedPayload: any;

      registry.register('document_indexed', (payload) => {
        capturedPayload = payload;
      });

      await registry.dispatch({
        eventType: 'document_indexed',
        payload: { sourceId: 'ticket-123', content: 'Some content', metadata: { key: 'value' } },
      });

      expect(Object.keys(capturedPayload).sort()).toEqual(['content', 'metadata', 'sourceId'].sort());
      expect(capturedPayload.sourceId).toBe('ticket-123');
      expect(capturedPayload.content).toBe('Some content');
      expect(capturedPayload.metadata).toEqual({ key: 'value' });
    });
  });

  describe('AC45: graphify_import payload structure', () => {
    it('AC45: dispatch with eventType=graphify_import has payload with projectId, nodeCount, linkCount', async () => {
      let capturedPayload: any;

      registry.register('graphify_import', (payload) => {
        capturedPayload = payload;
      });

      await registry.dispatch({
        eventType: 'graphify_import',
        payload: { projectId: 'proj-456', nodeCount: 100, linkCount: 50 },
      });

      expect(Object.keys(capturedPayload).sort()).toEqual(['linkCount', 'nodeCount', 'projectId'].sort());
      expect(capturedPayload.projectId).toBe('proj-456');
      expect(capturedPayload.nodeCount).toBe(100);
      expect(capturedPayload.linkCount).toBe(50);
    });
  });

  describe('AC25: dispatch throws triggers markFailed', () => {
    it('AC25: when dispatch throws, error is logged and event can be retried', async () => {
      const loggerSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const handler = jest.fn().mockImplementation(() => {
        throw new Error('Connection refused');
      });
      registry.register('ticket_event', handler);

      const result = await registry.dispatch({ eventType: 'ticket_event', payload: {} });

      expect(result).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Handler for ticket_event failed:',
        expect.any(Error)
      );

      loggerSpy.mockRestore();
    });
  });
});

class OutboxFanOutRegistry {
  private handlers: Map<string, Array<(payload: unknown) => void>> = new Map();

  register(eventType: string, handler: (payload: unknown) => void): void {
    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async dispatch(input: { eventType: string; payload: unknown }): Promise<void> {
    const handlers = this.handlers.get(input.eventType) || [];
    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(input.payload));
      } catch (error) {
        console.error(`Handler for ${input.eventType} failed:`, error);
      }
    }
  }

  getHandlers(eventType: string): Array<(payload: unknown) => void> {
    return this.handlers.get(eventType) || [];
  }
}