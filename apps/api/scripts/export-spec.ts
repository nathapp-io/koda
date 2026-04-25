/**
 * Export OpenAPI spec to openapi.json at the monorepo root.
 *
 * Usage: bun run api:export-spec (from monorepo root)
 *
 * This script bootstraps the NestJS app, extracts the Swagger document,
 * writes it to ../../openapi.json, then exits cleanly.
 * Run this after any API changes before running `bun run generate`.
 */

import 'reflect-metadata';
import { AppFactory } from '@nathapp/nestjs-app';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';

async function exportSpec() {
  const app = await AppFactory.createFastifyApp(AppModule, { logger: false });
  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('Koda API')
    .setDescription('Dev ticket tracker API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outputPath = resolve(__dirname, '../../../openapi.json');
  writeFileSync(outputPath, JSON.stringify(document, null, 2));

  console.log(`✅ OpenAPI spec exported to ${outputPath}`);
  await app.close();
  process.exit(0);
}

exportSpec().catch((err) => {
  console.error('❌ Failed to export spec:', err);
  process.exit(1);
});
