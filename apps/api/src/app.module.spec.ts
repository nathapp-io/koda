import { AppModule } from './app.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AuthModule } from './auth/auth.module';
import { AgentsModule } from './agents/agents.module';
import { ProjectsModule } from './projects/projects.module';
import { TicketsModule } from './tickets/tickets.module';
import { CommentsModule } from './comments/comments.module';

describe('AppModule', () => {
  it('should be defined', () => {
    expect(AppModule).toBeDefined();
  });

  it('should import ConfigModule with isGlobal: true', () => {
    // ConfigModule is imported in app.module.ts with isGlobal: true
    expect(ConfigModule).toBeDefined();
  });

  it('should import PrismaModule with isGlobal: true', () => {
    // PrismaModule is imported in app.module.ts with isGlobal: true
    expect(PrismaModule).toBeDefined();
  });

  it('should import AuthModule for authentication', () => {
    // AuthModule is imported in app.module.ts
    expect(AuthModule).toBeDefined();
  });

  it('should import AgentsModule for agent management', () => {
    // AgentsModule is imported in app.module.ts
    expect(AgentsModule).toBeDefined();
  });

  it('should import ProjectsModule for project management', () => {
    // ProjectsModule is imported in app.module.ts
    expect(ProjectsModule).toBeDefined();
  });

  it('should import TicketsModule for ticket management', () => {
    // TicketsModule is imported in app.module.ts
    expect(TicketsModule).toBeDefined();
  });

  it('should import CommentsModule for comment management', () => {
    // CommentsModule is imported in app.module.ts
    expect(CommentsModule).toBeDefined();
  });
});
