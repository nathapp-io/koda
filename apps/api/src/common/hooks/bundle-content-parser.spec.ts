import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Readable } from 'stream';
import { registerBundleContentParser } from './bundle-content-parser';
import { registerRawBodyHook } from './raw-body.hook';

describe('registerBundleContentParser (production adapter, plan D12)', () => {
  it('hands a 2 MiB gzip body to the handler as a stream, past the 1 MiB JSON cap', async () => {
    const fastify = new FastifyAdapter().getInstance();
    registerRawBodyHook(fastify as never);
    registerBundleContentParser(fastify as never);
    fastify.put('/up', async (req) => {
      let bytes = 0;
      for await (const chunk of req.body as AsyncIterable<Buffer>) bytes += chunk.length;
      return { bytes, stream: req.body instanceof Readable };
    });
    const res = await fastify.inject({ method: 'PUT', url: '/up', headers: { 'content-type': 'application/gzip' }, payload: Buffer.alloc(2 * 1024 * 1024) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bytes: 2 * 1024 * 1024, stream: true });
    await fastify.close();
  });
});
