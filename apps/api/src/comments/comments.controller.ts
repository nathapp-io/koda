import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
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
import { Principal, RequiredPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('comments')
@ApiBearerAuth()
@Controller()
export class CommentsController {
  constructor(private commentsService: CommentsService) {}

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
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a comment on a ticket' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
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
  @ApiOperation({ summary: 'List all comments for a ticket' })
  @ApiResponse({ status: 200, description: 'List of comments' })
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
  @ApiOperation({ summary: 'Update a comment' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  @ApiResponse({ status: 403, description: 'Not authorized to edit this comment' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  @RequiredPermission([CaslPermissionAction.UPDATE, 'Comment'])
  async updateFromHttp(
    @Param('id') id: string,
    @Body() updateCommentDto: UpdateCommentDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.update(id, updateCommentDto, principal);
    return JsonResponse.Ok(data);
  }

  @Delete('comments/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a comment' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  @ApiResponse({ status: 403, description: 'Not authorized to delete this comment' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  @RequiredPermission([CaslPermissionAction.DELETE, 'Comment'])
  async deleteFromHttp(
    @Param('id') id: string,
    @Principal() principal: KodaPrincipal,
  ) {
    await this.delete(id, principal);
    return JsonResponse.Ok(null);
  }
}
