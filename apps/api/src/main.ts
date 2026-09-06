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
