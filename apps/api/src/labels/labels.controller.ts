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
import { LabelsService } from './labels.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import { CurrentActor } from '../auth/decorators/current-user.decorator';

type CurrentUser = { id: string; sub: string; role?: string } | null;

@ApiTags('labels')
@ApiBearerAuth()
@Controller()
export class LabelsController {
  constructor(private labelsService: LabelsService) {}

  // Public methods for testing (called directly in tests)
  async create(
    slug: string,
    createLabelDto: CreateLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.labelsService.create(slug, createLabelDto, currentUser, actorType);
  }

  async findByProject(slug: string) {
    return this.labelsService.findByProject(slug);
  }

  async update(
    slug: string,
    labelId: string,
    updateLabelDto: UpdateLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.labelsService.update(slug, labelId, updateLabelDto, currentUser, actorType);
  }

  async delete(
    slug: string,
    labelId: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.labelsService.delete(slug, labelId, currentUser, actorType);
  }

  async assignLabel(
    slug: string,
    ref: string,
    assignLabelDto: AssignLabelDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.labelsService.assignToTicket(slug, ref, assignLabelDto, currentUser, actorType);
  }

  async removeLabel(
    slug: string,
    ref: string,
    labelId: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    return this.labelsService.removeFromTicket(slug, ref, labelId, currentUser, actorType);
  }

  // HTTP route handlers
  @Post('projects/:slug/labels')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a label for a project' })
  @ApiResponse({ status: 201, description: 'Label created' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'Unauthorized - admin only' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async createFromHttp(
    @Param('slug') slug: string,
    @Body() createLabelDto: CreateLabelDto,
    @CurrentActor() actor: { currentUser: CurrentUser; actorType: 'user' | 'agent' | undefined },
  ) {
    const currentUser = actor.currentUser ?? { id: '', sub: '' };
    const data = await this.create(slug, createLabelDto, currentUser, actor.actorType ?? 'user');
    return JsonResponse.Ok(data);
  }

  @Get('projects/:slug/labels')
  @ApiOperation({ summary: 'List all labels for a project' })
  @ApiResponse({ status: 200, description: 'List of labels' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findByProjectFromHttp(@Param('slug') slug: string) {
    const data = await this.findByProject(slug);
    return JsonResponse.Ok(data);
  }

  @Patch('projects/:slug/labels/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a label' })
  @ApiResponse({ status: 200, description: 'Label updated' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'Unauthorized - admin only' })
  @ApiResponse({ status: 404, description: 'Label or project not found' })
  async updateFromHttp(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() updateLabelDto: UpdateLabelDto,
    @CurrentActor() actor: { currentUser: CurrentUser; actorType: 'user' | 'agent' | undefined },
  ) {
    const currentUser = actor.currentUser ?? { id: '', sub: '' };
    const data = await this.update(slug, id, updateLabelDto, currentUser, actor.actorType ?? 'user');
    return JsonResponse.Ok(data);
  }

  @Delete('projects/:slug/labels/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a label' })
  @ApiResponse({ status: 204, description: 'Label deleted' })
  @ApiResponse({ status: 403, description: 'Unauthorized - admin only' })
  @ApiResponse({ status: 404, description: 'Label or project not found' })
  async deleteFromHttp(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentActor() actor: { currentUser: CurrentUser; actorType: 'user' | 'agent' | undefined },
  ) {
    const currentUser = actor.currentUser ?? { id: '', sub: '' };
    return this.delete(slug, id, currentUser, actor.actorType ?? 'user');
  }

  @Post('projects/:slug/tickets/:ref/labels')
  @HttpCode(201)
  @ApiOperation({ summary: 'Assign a label to a ticket' })
  @ApiResponse({ status: 201, description: 'Label assigned to ticket' })
  @ApiResponse({ status: 400, description: 'Invalid request data or label already assigned' })
  @ApiResponse({ status: 404, description: 'Ticket or label not found' })
  async assignLabelFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() assignLabelDto: AssignLabelDto,
    @CurrentActor() actor: { currentUser: CurrentUser; actorType: 'user' | 'agent' | undefined },
  ) {
    const currentUser = actor.currentUser ?? { id: '', sub: '' };
    const data = await this.assignLabel(slug, ref, assignLabelDto, currentUser, actor.actorType ?? 'user');
    return JsonResponse.Ok(data);
  }

  @Delete('projects/:slug/tickets/:ref/labels/:labelId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a label from a ticket' })
  @ApiResponse({ status: 204, description: 'Label removed from ticket' })
  @ApiResponse({ status: 404, description: 'Ticket or label assignment not found' })
  async removeLabelFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Param('labelId') labelId: string,
    @CurrentActor() actor: { currentUser: CurrentUser; actorType: 'user' | 'agent' | undefined },
  ) {
    const currentUser = actor.currentUser ?? { id: '', sub: '' };
    return this.removeLabel(slug, ref, labelId, currentUser, actor.actorType ?? 'user');
  }
}
