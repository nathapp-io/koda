import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { COMMENT_ROUTE_VARIANTS } from './comment-route.commands';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';

@ApiTags('comments')
@ApiBearerAuth()
@Controller()
export class CommentsController {
  constructor(
    private commentsService: CommentsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  // Public methods for testing (called directly in tests)
  async create(
    slug: string,
    ref: string,
    createCommentDto: CreateCommentDto,
    principal: KodaPrincipal,
  ) {
    return this.commentsService.create(slug, ref, createCommentDto, principal);
  }

  async listByTicket(
    slug: string,
    ref: string,
  ) {
    return this.commentsService.findByTicket(slug, ref);
  }

  async update(
    id: string,
    updateCommentDto: UpdateCommentDto,
    principal: KodaPrincipal,
  ) {
    return this.commentsService.update(id, updateCommentDto, principal);
  }

  async delete(
    id: string,
    principal: KodaPrincipal,
  ) {
    await this.commentsService.delete(id, principal);
  }

  // HTTP route handlers
  @Post('projects/:slug/tickets/:ref/comments')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('comment.create')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a comment on a ticket' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'comment.create is missing' })
  @ApiResponse({ status: 404, description: 'Project or ticket not found' })
  async createFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() createCommentDto: CreateCommentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.create(slug, ref, createCommentDto, principal);
    return JsonResponse.Ok(data);
  }

  @Get('projects/:slug/tickets/:ref/comments')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('comment.read')
  @ApiOperation({ summary: 'List all comments for a ticket' })
  @ApiResponse({ status: 200, description: 'List of comments' })
  @ApiResponse({ status: 403, description: 'comment.read is missing' })
  @ApiResponse({ status: 404, description: 'Project or ticket not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listByTicketFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
  ) {
    const data = await this.listByTicket(slug, ref);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data);
  }

  @Patch('comments/:id')
  // US-005: slug-less mutation — the project and the comment's author are only
  // known after the row lookup, so `CommentsService.update` makes the check.
  @Requires('comment.update', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Update a comment' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  @ApiResponse({ status: 403, description: 'comment.update is missing, or the comment is someone else\'s and only comment.update.own is held' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async updateFromHttp(
    @Param('id') id: string,
    @Body() updateCommentDto: UpdateCommentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.update(id, updateCommentDto, principal);
    return JsonResponse.Ok(data);
  }

  @Delete('comments/:id')
  @HttpCode(204)
  @ApprovalGated()
  // US-005: the command checks comment.delete on the row's author when it executes.
  @Requires('comment.delete', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Delete a comment' })
  @ApiResponse({ status: 204, description: 'Comment deleted' })
  @ApiResponse({ status: 403, description: 'comment.delete is missing, or the comment is someone else\'s and only comment.delete.own is held' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async deleteFromHttp(
    @Param('id') id: string,
    @Principal() principal: KodaPrincipal,
  ) {
    const projectId = await this.commentsService.resolveCommentProject(id, principal);
    const outcome = await this.routeGate.run<null>({
      key: 'comment.delete',
      variant: COMMENT_ROUTE_VARIANTS.delete,
      projectId,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
