import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { I18nCoreModule } from '@nathapp/nestjs-common';
import { LoggingModule } from '@nathapp/nestjs-logging';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AgentsModule } from './agents/agents.module';
import { ProjectsModule } from './projects/projects.module';
import { TicketsModule } from './tickets/tickets.module';
import { CommentsModule } from './comments/comments.module';
import { LabelsModule } from './labels/labels.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    I18nCoreModule.forRoot({
      loaderOptions: {
        path: join(__dirname, 'i18n'),
        watch: false,
      },
    }),
    LoggingModule,
    PrismaModule,
    AuthModule,
    AgentsModule,
    ProjectsModule,
    TicketsModule,
    CommentsModule,
    LabelsModule,
  ],
})
export class AppModule {}
