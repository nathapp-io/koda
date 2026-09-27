import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { ProjectAccessModule } from '../projects/project-access.module';

@Module({
  imports: [AuthModule, EventsModule, ProjectAccessModule],
  controllers: [CommentsController],
  providers: [
    PrismaCommentRepository,
    { provide: COMMENT_REPOSITORY, useExisting: PrismaCommentRepository },
    CommentsService,
  ],
})
export class CommentsModule {}
