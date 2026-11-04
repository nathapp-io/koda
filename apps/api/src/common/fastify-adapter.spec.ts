import { THREAD_REQUEST_ID_MAX } from '../fleet/threads/thread-decision';
import { createFastifyAdapter, MAX_PATH_PARAM_LENGTH } from './fastify-adapter';

/**
 * thread-agents-modes US-008 (F1): the router's parameter limit must cover the approval request id, and stay above it
 * so an over-long id reaches the handler's 400 rather than the router's 414.
 */
describe('createFastifyAdapter', () => {
  it('accepts the longest approval request id the API stores and decides', () => {
    expect(MAX_PATH_PARAM_LENGTH).toBeGreaterThanOrEqual(THREAD_REQUEST_ID_MAX);
    // Above the bound on purpose: the service answers 400 naming requestId for 129..MAX, not the router.
    expect(MAX_PATH_PARAM_LENGTH).toBeGreaterThan(THREAD_REQUEST_ID_MAX);
  });

  it('routes a parameter of the accepted bound and refuses one past the router limit', async () => {
    const instance = createFastifyAdapter().getInstance();
    instance.get('/probe/:requestId', async () => 'ok');
    try {
      const accepted = await instance.inject({ method: 'GET', url: `/probe/${'r'.repeat(THREAD_REQUEST_ID_MAX)}` });
      expect(accepted.statusCode).toBe(200);
      // The router's own refusal is the transport error F1 was about.
      const refused = await instance.inject({ method: 'GET', url: `/probe/${'r'.repeat(MAX_PATH_PARAM_LENGTH + 1)}` });
      expect(refused.statusCode).toBe(414);
      expect(refused.json()).toMatchObject({ code: 'FST_ERR_MAX_PARAM_LENGTH' });
    } finally {
      await instance.close();
    }
  });
});
