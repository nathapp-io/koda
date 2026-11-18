import { AppFactory } from '@nathapp/nestjs-app';
import { Logger } from '@nathapp/nestjs-logging';
import { AppModule } from './app.module';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard';
import { APP_CFG, IAppConfig } from './config/app.config';
import { FastifyRuntimePlugin } from './common/bootstrap/fastify-runtime.plugin';
import { enableGracefulShutdown } from './common/bootstrap/graceful-shutdown';
import { createFastifyAdapter } from './common/fastify-adapter';
import { TRUSTED_PROXIES } from './common/trusted-proxies';

async function bootstrap() {
  const app = await AppFactory.createFastifyApp(AppModule, createFastifyAdapter(), {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  // App-specific Fastify wiring (rawBody capture, upload content parsers) is a
  // bootstrap plugin so the HTTP test harness runs the exact same steps.
  app.usePlugin(new FastifyRuntimePlugin());

  // H2: getClientIp() only honours forwarded headers when trust proxy is configured via
  // configureTrustProxy(). Trust the loopback/private-network proxies (e.g. the Nuxt /api proxy) so the
  // throttler tracks real client IPs instead of collapsing all proxied traffic into one bucket, and so
  // the refresh route records the browser's address rather than the web container's (#470). Fastify's
  // own `req.ip` is unaffected by this — it stays the socket peer (see `createFastifyAdapter`).
  app.configureTrustProxy({ enabled: true, trustedProxies: TRUSTED_PROXIES });

  const { port, host } = app.get<IAppConfig>(APP_CFG);

  // DI container is ready right after createFastifyApp() — get the guard before
  // setting up global handlers. Global guards MUST be registered before init()
  // because NestJS compiles route handlers (capturing guards) during init().
  const combinedGuard = app.get(CombinedAuthGuard);
  app.setJwtAuthGuard(combinedGuard);

  // Review US-004: register the SIGTERM/SIGINT hooks so a container stop closes the server instead of
  // killing it mid-request. Registered before init() so no request is served without a shutdown path.
  enableGracefulShutdown(app);

  await app.useServerSecurityConfig();

  app
    .useAppGlobalPrefix()
    .useAppGlobalPipes()
    .useAppGlobalFilters()
    .useAppGlobalGuards()
    .useSwaggerUIOnDevOnly({
      name: 'Koda API',
      description: 'Dev ticket tracker API',
      version: '1.0.0',
    });

  // Install bootstrap plugins before the server starts (the documented
  // @nathapp/nestjs-app sequence: register plugins, `ready()`, then `start()`).
  // Must also precede `init()`: Fastify freezes hooks/content-type parsers
  // when a route's context is built.
  await app.ready();

  await app.start(port, host);
}

bootstrap();
