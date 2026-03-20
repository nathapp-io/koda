import { AppFactory } from '@nathapp/nestjs-app';
import { Logger } from '@nathapp/nestjs-logging';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await AppFactory.createFastifyApp(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const apiPort = parseInt(process.env.API_PORT || '3100', 10);

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

  await app.start(apiPort);
}

bootstrap();
