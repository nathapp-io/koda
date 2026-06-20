import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { I18nCoreModule } from '@nathapp/nestjs-common';
import { CacheModule, CacheStrategy } from '@nathapp/nestjs-cache';
import { LoggingModule } from '@nathapp/nestjs-logging';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ThrottlerModule } from '@nathapp/nestjs-throttler';
import { PrismaClient } from '@prisma/client';
import { AuthModule } from './auth/auth.module';
import { AgentsModule } from './agents/agents.module';
import { ProjectsModule } from './projects/projects.module';
import { TicketsModule } from './tickets/tickets.module';
import { CommentsModule } from './comments/comments.module';
import { LabelsModule } from './labels/labels.module';
import { TicketLinksModule } from './ticket-links/ticket-links.module';
import { HealthModule } from './health/health.module';
import { RagModule } from './rag/rag.module';
import { WebhookModule } from './webhook/webhook.module';
import { CiWebhookModule } from './ci-webhook/ci-webhook.module';
import { VcsModule } from './vcs/vcs.module';
import { KodaDomainWriterModule } from './koda-domain-writer/koda-domain-writer.module';
import { OutboxModule } from './outbox/outbox.module';
import { MemoryModule } from './memory/memory.module';
import { CodeIntelModule } from './code-intel/code-intel.module';
import { EntityGraphModule } from './entity-graph/entity-graph.module';
import { ContextModule } from './context/context.module';
import { PolicyModule } from './policy/policy.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { APP_CFG, IAppConfig, appConfig } from './config/app.config';
import { AUTH_CFG, IAuthConfig, authConfig } from './config/auth.config';
import { databaseConfig } from './config/database.config';
import { RAG_CFG, IRagConfig, ragConfig } from './config/rag.config';
import { VCS_CFG, IVcsConfig, vcsConfig } from './config/vcs.config';
import { validate } from './config/env.validation';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, authConfig, databaseConfig, ragConfig, vcsConfig],
      validate: validate,
    }),
    I18nCoreModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: join(__dirname, 'i18n'),
        watch: false,
      },      
    }),
    LoggingModule.register({}),
    PrismaModule.forRoot({
      isGlobal: true,
      client: PrismaClient,
      transaction: true,
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
        throttlers: [{ name: 'default', ttl: 60000, limit: 100 }],
      }),
    }),
    AuthModule,
    AgentsModule,
    ProjectsModule,
    TicketsModule,
    CommentsModule,
    LabelsModule,
    TicketLinksModule,
    HealthModule,
    RagModule,
    WebhookModule,
    CiWebhookModule,
    VcsModule,
    OutboxModule,
    KodaDomainWriterModule,
    MemoryModule,
    CodeIntelModule,
    EntityGraphModule,
    ContextModule,
    PolicyModule,
    MonitoringModule,
  ],
  providers: [
    { provide: APP_CFG,  useFactory: (cs: ConfigService) => cs.get<IAppConfig>('app'),  inject: [ConfigService] },
    { provide: AUTH_CFG, useFactory: (cs: ConfigService) => cs.get<IAuthConfig>('auth'), inject: [ConfigService] },
    { provide: RAG_CFG,  useFactory: (cs: ConfigService) => cs.get<IRagConfig>('rag'),   inject: [ConfigService] },
    { provide: VCS_CFG,  useFactory: (cs: ConfigService) => cs.get<IVcsConfig>('vcs'),   inject: [ConfigService] },
  ],
  exports: [APP_CFG, AUTH_CFG, RAG_CFG, VCS_CFG],
})
export class AppModule {}
