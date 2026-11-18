import type { NathApplication } from '@nathapp/nestjs-app';

/**
 * Review US-004: without shutdown hooks a SIGTERM from the container runtime kills the process
 * mid-request, leaving in-flight work and open database connections behind. `main.ts` calls this
 * before `app.start`, so the adapter closes the server and every `onModuleDestroy` runs.
 */
export function enableGracefulShutdown(app: NathApplication): void {
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
}
