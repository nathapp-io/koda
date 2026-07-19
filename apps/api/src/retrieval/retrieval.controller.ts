import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenAppException, NotFoundAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { EvaluationService } from './evaluation.service';
import { PrismaRagRepository } from '../rag/prisma-rag.repository';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller('projects/:slug/kb')
export class RetrievalController {
  constructor(
    private readonly evaluationService: EvaluationService,
    private readonly ragRepository: PrismaRagRepository,
  ) {}

  private async resolveProject(slug: string) {
    const project = await this.ragRepository.findProjectBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'rag');
    return project;
  }

  private async checkProjectMembership(
    projectId: string,
    principal: KodaPrincipal | null,
  ): Promise<void> {
    if (!principal) {
      throw new ForbiddenAppException({}, 'rag');
    }

    // Agent principals are cross-project (their API key is their credential).
    // Actor shape is normalized in CombinedAuthGuard and read through principal type guards.
    if (isAgentPrincipal(principal)) {
      return;
    }

    if (!isUserPrincipal(principal)) {
      throw new ForbiddenAppException({}, 'rag');
    }

    // ADMIN users have global permissions and do not need project membership.
    if (principal.role === 'ADMIN') {
      return;
    }

    const membership = await this.ragRepository.findProjectMembership(projectId, principal.id);

    if (!membership) {
      throw new ForbiddenAppException({}, 'rag');
    }

    const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT', 'VIEWER'];
    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenAppException({}, 'rag');
    }
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
