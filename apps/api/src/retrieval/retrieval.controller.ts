import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { EvaluationService } from './evaluation.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
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

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'rag');
    }
    // assertProjectMembership throws ForbiddenAppException when access is denied;
    // agent and ADMIN-user bypass semantics are preserved inside the shared service.
    await this.projectAccess.assertProjectMembership(projectId, principal);
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
    @Principal() principal: KodaPrincipal,
  ) {
    const project = await this.resolveProject(slug);
    await this.checkProjectMembership(project.id, principal);
    const { loadEvalQueries } = await import('./load-queries');
    const queries = loadEvalQueries();
    const projectQueries = queries.filter((q) => q.projectId === project.id);
    const summary = await this.evaluationService.runQueries(projectQueries);
    return JsonResponse.Ok(summary);
  }
}
