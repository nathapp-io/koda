import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestWithUser = any & { user?: any; agent?: any };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CurrentUser = any;

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
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.commentsService.create(slug, ref, createCommentDto, currentUser, actorType);
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
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.commentsService.update(id, updateCommentDto, currentUser, actorType);
  }

  async delete(
    id: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    await this.commentsService.delete(id, currentUser, actorType);
  }

  // HTTP route handlers
  @Post('projects/:slug/tickets/:ref/comments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a comment on a ticket' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Project or ticket not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() createCommentDto: CreateCommentDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType = req.user ? 'user' : 'agent';
    const data = await this.create(slug, ref, createCommentDto, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data) as any;
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
    return JsonResponse.Ok(data) as any;
  }

  @Patch('comments/:id')
  @ApiOperation({ summary: 'Update a comment' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  @ApiResponse({ status: 403, description: 'Not authorized to edit this comment' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateFromHttp(
    @Param('id') id: string,
    @Body() updateCommentDto: UpdateCommentDto,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType = req.user ? 'user' : 'agent';
    const data = await this.update(id, updateCommentDto, currentUser, actorType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JsonResponse.Ok(data) as any;
  }

  @Delete('comments/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a comment' })
  @ApiResponse({ status: 204, description: 'Comment deleted' })
  @ApiResponse({ status: 403, description: 'Not authorized to delete this comment' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async deleteFromHttp(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ) {
    const currentUser = req.user || req.agent;
    const actorType = req.user ? 'user' : 'agent';
    await this.delete(id, currentUser, actorType);
  }
}
