import { AppFactory } from '@nathapp/nestjs-app';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await AppFactory.createFastifyApp(AppModule, {
    bufferLogs: true,
  });

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
