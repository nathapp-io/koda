import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AgentsModule } from './agents/agents.module';
import { ProjectsModule } from './projects/projects.module';
import { TicketsModule } from './tickets/tickets.module';
import { CommentsModule } from './comments/comments.module';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    AuthModule,
    AgentsModule,
    ProjectsModule,
    TicketsModule,
    CommentsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CombinedAuthGuard,
    },
  ],
})
export class AppModule {}
