import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { parseQuery, remapPage } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { ApprovalPolicyService } from './approval-policy.service';
import { rethrowApprovalError } from './approval-http-errors';
import { approvableKeys } from './approvable-keys';
import { ApprovalPolicyDto, ApprovableKeyDto, CreateApprovalPolicyDto, UpdateApprovalPolicyDto } from './dto/approval-policy.dto';
import { ApprovalPolicyNotFoundError } from './domain/approval.errors';
import { toPolicySubject } from './dto/approval-policy-subject.dto';
import { ListApprovalPoliciesQuery } from './dto/list-approval-policies.query';

@ApiTags('approvals')
@ApiBearerAuth()
@ApiExtraModels(ApprovalPolicyDto, ApprovableKeyDto)
@Controller('approval-policies')
export class ApprovalPoliciesController {
  constructor(private readonly policies: ApprovalPolicyService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'List global approval policies' })
  @ApiResponse({ status: 200, description: 'Page of global policies', schema: {
    type: 'object', properties: { ret: { type: 'number' }, data: {
      type: 'object', properties: {
        total: { type: 'number' }, current: { type: 'number' }, size: { type: 'number' },
        hasNext: { type: 'boolean' }, hasPrev: { type: 'boolean' },
        records: { type: 'array', items: { $ref: getSchemaPath(ApprovalPolicyDto) } },
      },
    } },
  } })
  @ApiResponse({ status: 400, description: 'Invalid query' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Global policy management permission required' })
  async list(@Query() rawQuery: ListApprovalPoliciesQuery) {
    try {
      const { current, size, permissionPattern } = parseQuery(ListApprovalPoliciesQuery, rawQuery);
      return JsonResponse.Ok(remapPage(await this.policies.page({ projectId: null, permissionPattern }, { current, size }), ApprovalPolicyDto.from));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Get('keys')
  @UseGuards(RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'List approvable permission keys' })
  @ApiResponse({ status: 200, description: 'Approvable keys and their approval floors and defaults', schema: {
    type: 'object', properties: { ret: { type: 'number' }, data: {
      type: 'object', properties: { keys: { type: 'array', items: { $ref: getSchemaPath(ApprovableKeyDto) } } },
    } },
  } })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Global policy management permission required' })
  keys() {
    try { return JsonResponse.Ok({ keys: approvableKeys() }); }
    catch (error) { rethrowApprovalError(error); }
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'Create a global approval policy' })
  @ApiResponse({ status: 201, description: 'Created global policy', schema: {
    type: 'object', properties: { ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalPolicyDto) } },
  } })
  @ApiResponse({ status: 400, description: 'Invalid approval policy' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Permission denied or self-applying agent policy' })
  @ApiResponse({ status: 409, description: 'Policy pattern and subject already exist' })
  async create(@Body() dto: CreateApprovalPolicyDto) {
    try {
      return JsonResponse.Ok(ApprovalPolicyDto.from(await this.policies.create({ ...dto, appliesTo: toPolicySubject(dto.appliesTo), projectId: null })));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Patch(':id')
  @UseGuards(RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'Update a global approval policy' })
  @ApiResponse({ status: 200, description: 'Updated global policy', schema: { type: 'object', properties: { ret: { type: 'number' }, data: { $ref: getSchemaPath(ApprovalPolicyDto) } } } })
  @ApiResponse({ status: 400, description: 'Invalid or empty policy update' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Global policy management permission required' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @ApiResponse({ status: 409, description: 'Invalid policy conflict' })
  async update(@Param('id') id: string, @Body() dto: UpdateApprovalPolicyDto) {
    try {
      if (!Object.values(dto).some((value) => value !== undefined)) throw new ValidationAppException({}, 'approvals.emptyPolicyPatch');
      const policy = await this.policies.get(id);
      if (policy.projectId !== null) throw new ApprovalPolicyNotFoundError(id);
      return JsonResponse.Ok(ApprovalPolicyDto.from(await this.policies.update(id, dto)));
    } catch (error) { rethrowApprovalError(error); }
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RequiresGuard)
  @Requires('approval.policy.manage')
  @ApiOperation({ summary: 'Delete a global approval policy' })
  @ApiResponse({ status: 204, description: 'Global policy deleted' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Global policy management permission required' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async remove(@Param('id') id: string): Promise<void> {
    try {
      const policy = await this.policies.get(id);
      if (policy.projectId !== null) throw new ApprovalPolicyNotFoundError(id);
      await this.policies.remove(id);
    } catch (error) { rethrowApprovalError(error); }
  }
}
