import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { EvaluationService } from './evaluation.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
@UseGuards(ProjectMembershipGuard)
export class RetrievalController {
  constructor(
    private readonly evaluationService: EvaluationService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  private async resolveProject(slug: string): Promise<{ id: string }> {
    // findProjectIdBySlug throws NotFoundAppException if missing or soft-deleted
    const id = await this.projectAccess.findProjectIdBySlug(slug);
    return { id };
  }

  @Post('evaluate/retrieval')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run the retrieval evaluation harness with seeded queries' })
  @ApiResponse({ status: 200, description: 'Evaluation results with precision@5 metrics' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project role' })
  async evaluateRetrieval(
    @Param('slug') slug: string,
    @Principal() _principal: KodaPrincipal,
  ) {
    // Membership decision is made by ProjectMembershipGuard at class level.
    const project = await this.resolveProject(slug);
    const { loadEvalQueries } = await import('./load-queries');
    const queries = loadEvalQueries();
    const projectQueries = queries.filter((q) => q.projectId === project.id);
    const summary = await this.evaluationService.runQueries(projectQueries);
    return JsonResponse.Ok(summary);
  }
}
