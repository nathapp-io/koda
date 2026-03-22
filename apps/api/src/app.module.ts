import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { I18nCoreModule } from '@nathapp/nestjs-common';
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
import { appConfig } from './config/app.config';
import { authConfig } from './config/auth.config';
import { databaseConfig } from './config/database.config';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, authConfig, databaseConfig],
      validate: validate,
    }),
    I18nCoreModule.forRoot({
      loaderOptions: {
        path: join(__dirname, 'i18n'),
        watch: false,
      },
    }),
    LoggingModule.register({}),
    PrismaModule.forRoot({
      isGlobal: true,
      client: PrismaClient,
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
  ],
})
export class AppModule {}
