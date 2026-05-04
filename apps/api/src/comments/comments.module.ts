import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { PrismaCommentRepository } from './prisma-comment.repository';
import { COMMENT_REPOSITORY } from './domain/comment.domain';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [CommentsController],
  providers: [
    PrismaCommentRepository,
    { provide: COMMENT_REPOSITORY, useExisting: PrismaCommentRepository },
    CommentsService,
  ],
})
export class CommentsModule {}
