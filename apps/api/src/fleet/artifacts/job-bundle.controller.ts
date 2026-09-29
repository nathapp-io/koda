import { Controller, Get, Param, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { BundleService } from './bundle.service';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class JobBundleController {
  constructor(private readonly bundles: BundleService) {}

  @Get(':id/bundle')
  @ApiProduces('application/gzip')
  @ApiOperation({ summary: 'Download the latest run bundle (project member)' })
  @ApiResponse({ status: 200, description: 'tar.gz stream' })
  @ApiResponse({ status: 404, description: 'No such job or no bundle yet' })
  async download(@Param('id') id: string, @CurrentProject() ctx: ProjectContext): Promise<StreamableFile> {
    const { stream, leaseEpoch, sizeBytes } = await this.bundles.download(ctx.project.id, id);
    return new StreamableFile(stream, {
      type: 'application/gzip',
      disposition: `attachment; filename="koda-job-${id}-${leaseEpoch}.tar.gz"`,
      length: Number(sizeBytes),
    });
  }
}
