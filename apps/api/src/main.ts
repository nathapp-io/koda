import { Readable } from 'stream';
import { AppFactory } from '@nathapp/nestjs-app';
import { Logger } from '@nathapp/nestjs-logging';
import { HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard';

async function bootstrap() {
  const app = await AppFactory.createFastifyApp(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  // Register preParsing hook to allow empty JSON bodies before server starts
  const { httpAdapter } = app.get(HttpAdapterHost);
  const fastify = httpAdapter.getInstance();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.addHook('preParsing', async (request: any, _reply: unknown, payload: AsyncIterable<Buffer>) => {
    const ct = String(request.headers?.['content-type'] ?? '');
    if (!ct.includes('application/json')) return payload;

    // Collect the entire body stream
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    // Use empty JSON object if body is empty
    const body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from('{}');

    // Update Content-Length so Fastify's parser doesn't throw size mismatch
    request.headers['content-length'] = String(body.length);

    return Readable.from([body]);
  });

  const apiPort = parseInt(process.env.API_PORT || '3100', 10);

  // DI container is ready right after createFastifyApp() — get the guard before
  // setting up global handlers. Global guards MUST be registered before init()
  // because NestJS compiles route handlers (capturing guards) during init().
  const combinedGuard = app.get(CombinedAuthGuard);
  app.setJwtAuthGuard(combinedGuard);

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
