import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectContext } from '../projects/project-context';
import { LABEL_ROUTE_VARIANTS } from './label-route.commands';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
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
import { LabelsService } from './labels.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { AssignLabelDto } from './dto/assign-label.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { Requires } from '../permissions/requires.decorator';

@ApiTags('labels')
@ApiBearerAuth()
@Controller()
export class LabelsController {
  constructor(private labelsService: LabelsService, private readonly routeGate: ApprovalRouteGate) {}

  // Public methods for testing (called directly in tests)
  async create(
    slug: string,
    createLabelDto: CreateLabelDto,
    principal: KodaPrincipal,
  ) {
    return this.labelsService.create(slug, createLabelDto, principal);
  }

  async findByProject(slug: string) {
    return this.labelsService.findByProject(slug);
  }

  async update(
    slug: string,
    labelId: string,
    updateLabelDto: UpdateLabelDto,
    principal: KodaPrincipal,
  ) {
    return this.labelsService.update(slug, labelId, updateLabelDto, principal);
  }

  async delete(
    slug: string,
    labelId: string,
    principal: KodaPrincipal,
  ) {
    return this.labelsService.delete(slug, labelId, principal);
  }

  async assignLabel(
    slug: string,
    ref: string,
    assignLabelDto: AssignLabelDto,
    principal: KodaPrincipal,
  ) {
    return this.labelsService.assignToTicket(slug, ref, assignLabelDto, principal);
  }

  async removeLabel(
    slug: string,
    ref: string,
    labelId: string,
    principal: KodaPrincipal,
  ) {
    return this.labelsService.removeFromTicket(slug, ref, labelId, principal);
  }

  // HTTP route handlers
  @Post('projects/:slug/labels')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('label.create')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a label for a project' })
  @ApiResponse({ status: 201, description: 'Label created' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'label.create is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async createFromHttp(
    @Param('slug') slug: string,
    @Body() createLabelDto: CreateLabelDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.create(slug, createLabelDto, principal);
    return JsonResponse.Ok(data);
  }

  @Get('projects/:slug/labels')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('label.read')
  @ApiOperation({ summary: 'List all labels for a project' })
  @ApiResponse({ status: 200, description: 'List of labels' })
  @ApiResponse({ status: 403, description: 'label.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findByProjectFromHttp(@Param('slug') slug: string) {
    const data = await this.findByProject(slug);
    return JsonResponse.Ok(data);
  }

  @Patch('projects/:slug/labels/:id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('label.update')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a label' })
  @ApiResponse({ status: 200, description: 'Label updated' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'label.update is missing' })
  @ApiResponse({ status: 404, description: 'Label or project not found' })
  async updateFromHttp(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() updateLabelDto: UpdateLabelDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.update(slug, id, updateLabelDto, principal);
    return JsonResponse.Ok(data);
  }

  @Delete('projects/:slug/labels/:id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('label.delete')
  @ApprovalGated()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a label' })
  @ApiResponse({ status: 204, description: 'Label deleted' })
  @ApiResponse({ status: 403, description: 'label.delete is missing' })
  @ApiResponse({ status: 404, description: 'Label or project not found' })
  async deleteFromHttp(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run({
      key: 'label.delete', variant: LABEL_ROUTE_VARIANTS.delete,
      projectId: project.project.id, input: { slug, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }

  @Post('projects/:slug/tickets/:ref/labels')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.label.assign')
  @HttpCode(201)
  @ApiOperation({ summary: 'Assign a label to a ticket' })
  @ApiResponse({ status: 201, description: 'Label assigned to ticket' })
  @ApiResponse({ status: 400, description: 'Invalid request data or label already assigned' })
  @ApiResponse({ status: 403, description: 'ticket.label.assign is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or label not found' })
  async assignLabelFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() assignLabelDto: AssignLabelDto,
    @Principal() principal: KodaPrincipal,
  ) {
    const data = await this.assignLabel(slug, ref, assignLabelDto, principal);
    return JsonResponse.Ok(data);
  }

  @Delete('projects/:slug/tickets/:ref/labels/:labelId')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('ticket.label.remove')
  @ApprovalGated()
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a label from a ticket' })
  @ApiResponse({ status: 204, description: 'Label removed from ticket' })
  @ApiResponse({ status: 403, description: 'ticket.label.remove is missing' })
  @ApiResponse({ status: 404, description: 'Ticket or label assignment not found' })
  async removeLabelFromHttp(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Param('labelId') labelId: string,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run({
      key: 'ticket.label.remove', variant: LABEL_ROUTE_VARIANTS.remove,
      projectId: project.project.id, input: { slug, ref, labelId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
