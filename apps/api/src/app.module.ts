import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { GlobalExceptionsFilter, I18nCoreModule, ServerSecurityConfig } from '@nathapp/nestjs-common';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule, CacheStrategy } from '@nathapp/nestjs-cache';
import { LoggingModule } from '@nathapp/nestjs-logging';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ThrottlerModule, DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { PrismaClient } from './generated/prisma/client';
import { createPgAdapter } from './prisma/pg-adapter';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AgentsModule } from './agents/agents.module';
import { ProjectsModule } from './projects/projects.module';
import { ProjectMembersModule } from './projects/members/project-members.module';
import { ProjectInvitesModule } from './projects/invites/project-invites.module';
import { TicketsModule } from './tickets/tickets.module';
import { CommentsModule } from './comments/comments.module';
import { LabelsModule } from './labels/labels.module';
import { TicketLinksModule } from './ticket-links/ticket-links.module';
import { HealthModule } from './health/health.module';
import { RagModule } from './rag/rag.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { WebhookModule } from './webhook/webhook.module';
import { CiWebhookModule } from './ci-webhook/ci-webhook.module';
import { VcsModule } from './vcs/vcs.module';
import { WebhookSecurityModule } from './webhook-security/webhook-security.module';
import { KodaDomainWriterModule } from './koda-domain-writer/koda-domain-writer.module';
import { OutboxModule } from './outbox/outbox.module';
import { OutboxAdminModule } from './outbox/outbox-admin.module';
import { LiveModule } from './live/live.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EmailModule } from './email/email.module';
import { MemoryModule } from './memory/memory.module';
import { CodeIntelModule } from './code-intel/code-intel.module';
import { EntityGraphModule } from './entity-graph/entity-graph.module';
import { ContextModule } from './context/context.module';
import { PolicyModule } from './policy/policy.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { FleetModule } from './fleet/fleet.module';
import { HomeModule } from './home/home.module';
import { appConfig } from './config/app.config';
import { authConfig } from './config/auth.config';
import { DATABASE_CFG, IDatabaseConfig, databaseConfig } from './config/database.config';
import { ragConfig } from './config/rag.config';
import { vcsConfig } from './config/vcs.config';
import { outboxConfig } from './config/outbox.config';
import { notificationsConfig } from './config/notifications.config';
import { emailConfig } from './config/email.config';
import { globalThrottleLimit } from './config/throttle-limit';
import { liveConfig } from './config/live.config';
import { webhookConfig } from './config/webhook.config';
import { fleetConfig } from './config/fleet.config';
import { validate } from './config/env.validation';
import { ConfigBridgeModule } from './config/config-bridge.module';
import { KodaExceptionsFilter } from './common/exceptions/koda-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, authConfig, databaseConfig, ragConfig, vcsConfig, outboxConfig, liveConfig, webhookConfig, fleetConfig, notificationsConfig, emailConfig, ServerSecurityConfig],
      validate: validate,
    }),
    ConfigBridgeModule,
    ScheduleModule.forRoot(),
    I18nCoreModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: join(__dirname, 'i18n'),
        watch: false,
      },
    }),
    LoggingModule.register({}),
    PrismaModule.forRootAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        client: PrismaClient,
        clientOptions: { adapter: createPgAdapter(config.getOrThrow<IDatabaseConfig>(DATABASE_CFG).url) },
        transaction: true,
      }),
    }),
    CacheModule.register({
      isGlobal: true,
      strategy: CacheStrategy.MEMORY,
      memory: {
        lruSize: 1000,
        ttl: '10m',
      },
    }),
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [{ name: 'default', ttl: 60000, limit: globalThrottleLimit() }],
      }),
    }),
    AuthModule,
    UsersModule,
    AgentsModule,
    ProjectsModule,
    ProjectMembersModule,
    TicketsModule,
    CommentsModule,
    LabelsModule,
    TicketLinksModule,
    HealthModule,
    RagModule,
    RetrievalModule,
    WebhookModule,
    CiWebhookModule,
    VcsModule,
    WebhookSecurityModule,
    OutboxModule,
    OutboxAdminModule,
    LiveModule,
    NotificationsModule,
    EmailModule,
    KodaDomainWriterModule,
    MemoryModule,
    CodeIntelModule,
    EntityGraphModule,
    ContextModule,
    PolicyModule,
    MonitoringModule,
    FleetModule,
    HomeModule,
    ProjectInvitesModule,
  ],
  providers: [
    // H2: register the throttler guard globally so @Throttle decorators are enforced.
    // DefaultThrottlerGuard is exported (and injectable) via ThrottlerModule above.
    { provide: APP_GUARD, useClass: DefaultThrottlerGuard },
    // S4c US-003: NathApplication's useAppGlobalFilters() resolves this token from DI
    // before building its own filter, so the Koda error envelope (ret + message + the
    // refusing i18n key and args in `data`) is the one the API installs.
    { provide: GlobalExceptionsFilter, useClass: KodaExceptionsFilter },
  ],
})
export class AppModule {}
