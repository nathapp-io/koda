import { AppFactory } from '@nathapp/nestjs-app';
import { Logger } from '@nathapp/nestjs-logging';
import { HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard';
import { APP_CFG, IAppConfig } from './config/app.config';
import { registerRawBodyHook } from './common/hooks/raw-body.hook';

async function bootstrap() {
  const app = await AppFactory.createFastifyApp(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const { httpAdapter } = app.get(HttpAdapterHost);
  const fastify = httpAdapter.getInstance();
  registerRawBodyHook(fastify);

  // H2: the throttler guard's IP tracker (getClientIp) only honours forwarded
  // headers when trust proxy is configured via configureTrustProxy(). Trust the
  // loopback/private-network proxies (e.g. the Nuxt /api proxy) so rate limiting
  // tracks real client IPs instead of collapsing all proxied traffic into one bucket.
  app.configureTrustProxy({
    enabled: true,
    trustedProxies: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  });

  const { port, host } = app.get<IAppConfig>(APP_CFG);

  // DI container is ready right after createFastifyApp() — get the guard before
  // setting up global handlers. Global guards MUST be registered before init()
  // because NestJS compiles route handlers (capturing guards) during init().
  const combinedGuard = app.get(CombinedAuthGuard);
  app.setJwtAuthGuard(combinedGuard);

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

  await app.start(port, host);
}

bootstrap();
