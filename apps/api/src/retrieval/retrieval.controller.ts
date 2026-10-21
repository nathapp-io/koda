import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { EvaluationService } from './evaluation.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';

/**
 * The retrieval evaluation route (permissions P1 US-007).
 *
 * It declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`, so membership is resolved and a
 * non-member is refused before the key check. Only a Project Admin holds `retrieval.evaluate` (through `*`);
 * a Developer, Reviewer or Viewer's `*.read` grant does not reach it, and the handler's constructor stays
 * unchanged — the check needs no project row.
 */
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

  @Post('evaluate/retrieval')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('retrieval.evaluate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run the retrieval evaluation harness with seeded queries (retrieval.evaluate)' })
  @ApiResponse({ status: 200, description: 'Evaluation results with precision@5 metrics' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'retrieval.evaluate is missing, or the caller is not a member' })
  async evaluateRetrieval(@Param('slug') slug: string) {
    const project = await this.resolveProject(slug);
    const { loadEvalQueries } = await import('./load-queries');
    const queries = loadEvalQueries();
    const projectQueries = queries.filter((q) => q.projectId === project.id);
    const summary = await this.evaluationService.runQueries(projectQueries);
    return JsonResponse.Ok(summary);
  }
}
