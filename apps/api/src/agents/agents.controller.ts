import { Controller, Post, Body, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { AgentsService, CreateAgentDto } from './agents.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private agentsService: AgentsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Generate API key for an agent (admin only)' })
  @ApiResponse({ status: 201, description: 'API key generated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateApiKey(@Body() createAgentDto: CreateAgentDto, @Req() req: any) {
    // Check if user is admin
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }

    return this.agentsService.generateApiKey(createAgentDto);
  }
}
