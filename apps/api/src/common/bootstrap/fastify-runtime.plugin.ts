import type { INestApplication } from '@nestjs/common';
import type { AppBootstrapPlugin } from '@nathapp/nestjs-app';
import { registerBundleContentParser, registerLogContentParser } from '../hooks/bundle-content-parser';
import { registerRawBodyHook } from '../hooks/raw-body.hook';

/**
 * Koda's Fastify-specific bootstrap steps, shared by the production bootstrap
 * (`main.ts`) and the HTTP test harness (`test/helpers/http-app.ts`):
 *
 * - the `preParsing` hook captures raw request bytes for webhook HMAC
 *   verification and caps JSON bodies;
 * - bundle and log uploads (`application/gzip`, `application/octet-stream`)
 *   stream to their handlers unbuffered instead of answering 415.
 *
 * Registered as an `AppBootstrapPlugin` so both bootstraps run the
 * `usePlugin(...)` → `ready()` sequence documented by `@nathapp/nestjs-app`.
 * It must be installed before `ready()`/`listen()`: Fastify freezes a route's
 * hook and content-type parser state when its context is built.
 */
export class FastifyRuntimePlugin implements AppBootstrapPlugin {
  readonly name = 'koda-fastify-runtime';

  install(nestApp: INestApplication): void {
    const fastify = nestApp.getHttpAdapter().getInstance();
    registerRawBodyHook(fastify);
    registerBundleContentParser(fastify);
    registerLogContentParser(fastify);
  }
}
