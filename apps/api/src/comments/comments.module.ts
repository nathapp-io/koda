import { Module } from '@nestjs/common';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { CommentRouteCommands } from './comment-route.commands';

@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, AuthModule, EventsModule, ProjectAccessModule],
  controllers: [CommentsController],
  providers: [
    PrismaCommentRepository,
    { provide: COMMENT_REPOSITORY, useExisting: PrismaCommentRepository },
    CommentsService,
    CommentRouteCommands,
  ],
  exports: [CommentsService],
})
export class CommentsModule {}
