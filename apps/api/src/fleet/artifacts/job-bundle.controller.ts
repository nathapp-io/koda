import { Controller, Get, Param, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { BundleService } from './bundle.service';

/** Permissions P1d (US-004): `fleet.job.bundle.read` replaces the bare membership guard. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
export class JobBundleController {
  constructor(private readonly bundles: BundleService) {}

  @Get(':id/bundle')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.job.bundle.read')
  @ApiProduces('application/gzip')
  @ApiOperation({ summary: 'Download the latest run bundle (fleet.job.bundle.read)' })
  @ApiResponse({ status: 200, description: 'tar.gz stream' })
  @ApiResponse({ status: 403, description: 'fleet.job.bundle.read is missing' })
  @ApiResponse({ status: 404, description: 'No such job or no bundle yet' })
  @ApiResponse({ status: 410, description: 'The bundle was deleted by retention (S2a §5)' })
  async download(@Param('id') id: string, @CurrentProject() ctx: ProjectContext): Promise<StreamableFile> {
    const { stream, leaseEpoch, sizeBytes } = await this.bundles.download(ctx.project.id, id);
    return new StreamableFile(stream, {
      type: 'application/gzip',
      disposition: `attachment; filename="koda-job-${id}-${leaseEpoch}.tar.gz"`,
      length: Number(sizeBytes),
    });
  }
}
