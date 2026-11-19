import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
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

  /**
   * #484: an open SSE response is never idle, so with Fastify's default `forceCloseConnections: 'idle'` the
   * shutdown's `close()` never resolved and the container runtime SIGKILLed the api (exit 137).
   */
  it('closes while a streaming response is still open and ends the client socket', async () => {
    const instance = createFastifyAdapter().getInstance();
    instance.get('/stream', (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('event: ready\ndata: {}\n\n');
    });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    const { port } = instance.server.address() as AddressInfo;

    let request: http.ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // `firstChunk`: the client holds a live, non-idle stream before the shutdown starts.
      // `clientEnded`: the server ended the socket (a reset counts) once `close()` ran.
      let clientEnded: Promise<void> = Promise.resolve();
      await new Promise<void>((firstChunk, failed) => {
        clientEnded = new Promise<void>((ended, endFailed) => {
          request = http.get({ host: '127.0.0.1', port, path: '/stream' }, (response) => {
            response.once('data', () => firstChunk());
            response.on('close', ended);
          });
          request.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNRESET') return ended();
            failed(error);
            endFailed(error);
          });
        });
        clientEnded.catch(() => undefined);
      });

      const outcome = await Promise.race([
        instance.close().then(() => 'closed'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timed out'), 2_000);
        }),
      ]);
      expect(outcome).toBe('closed');
      await clientEnded;
    } finally {
      clearTimeout(timer);
      request?.destroy();
    }
  });
});
