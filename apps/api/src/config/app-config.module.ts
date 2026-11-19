import { ConfigModule, ConfigModuleOptions } from '@nestjs/config';
import { ServerSecurityConfig } from '@nathapp/nestjs-common';
import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { databaseConfig } from './database.config';
import { ragConfig } from './rag.config';
import { vcsConfig } from './vcs.config';
import { outboxConfig } from './outbox.config';
import { retentionConfig } from './retention.config';
import { webhookSignatureConfig } from './webhook-signature.config';
import { liveConfig } from './live.config';
import { webhookConfig } from './webhook.config';
import { fleetConfig } from './fleet.config';
import { notificationsConfig } from './notifications.config';
import { emailConfig } from './email.config';
import { providerCredentialsConfig } from './provider-credentials.config';
import { validate } from './env.validation';

/**
 * Every config namespace the application registers.
 *
 * Kept in its own module so the registration is exercised without a database: the same
 * `AppConfigModule` `AppModule` imports is what `app-config.module.spec.ts` compiles, so dropping a
 * factory from the list fails a DB-free test (`.nax/rules/api-testing.md`).
 */
export const APP_CONFIG_LOAD = [
  appConfig,
  authConfig,
  databaseConfig,
  ragConfig,
  vcsConfig,
  outboxConfig,
  retentionConfig,
  webhookSignatureConfig,
  liveConfig,
  webhookConfig,
  fleetConfig,
  notificationsConfig,
  emailConfig,
  providerCredentialsConfig,
  ServerSecurityConfig,
];

export const appConfigModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  envFilePath: '.env',
  load: APP_CONFIG_LOAD,
  validate,
};

export const AppConfigModule = ConfigModule.forRoot(appConfigModuleOptions);
