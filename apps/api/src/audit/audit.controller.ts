import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { AuditLogService } from './audit-log.service';
import { ListAuditQuery } from './dto/list-audit.query';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('audit.read')
  @ApiOperation({ summary: 'Audit entries, newest first; needs the global key audit.read' })
  @ApiResponse({ status: 200, description: 'Page of AuditEntryDto' })
  @ApiResponse({ status: 400, description: 'Invalid filter or date window' })
  @ApiResponse({ status: 403, description: 'Caller does not hold audit.read' })
  async list(@Query() rawQuery: ListAuditQuery) {
    const { current, size, ...query } = parseQuery(ListAuditQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.audit.list(query, { current, size })));
  }

  @Get('keys')
  @UseGuards(RequiresGuard)
  @Requires('audit.read')
  @ApiOperation({ summary: 'Every audit key that occurs, sorted ascending; needs the global key audit.read' })
  @ApiResponse({ status: 200, description: 'Distinct audit keys, unprefixed: { keys: string[] }' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  @ApiResponse({ status: 403, description: 'Caller does not hold audit.read' })
  async keys() {
    return JsonResponse.Ok({ keys: await this.audit.keys() });
  }
}
