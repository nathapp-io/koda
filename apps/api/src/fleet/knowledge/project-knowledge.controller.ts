import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { KnowledgeStoreUnavailableError } from './knowledge-chunk-store';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { KNOWLEDGE_ROUTE_VARIANTS } from './knowledge-route.commands';
import { KnowledgeIndexService } from './knowledge-index.service';
import { DEFAULT_KNOWLEDGE_PATTERNS } from './knowledge-patterns';
import { KnowledgeReindexResultDto, KnowledgeRepoStatesDto, toKnowledgeRepoState } from './knowledge-repo-state.dto';
import { KnowledgeSearchQuery, KnowledgeSearchResult, KnowledgeSearchService, parseKnowledgeSearchInput } from './knowledge-search.service';

export class KnowledgeSearchBodyDto {
  @Allow() @ApiProperty({ description: 'Search text, 1-500 characters', minLength: 1, maxLength: 500 }) query: string;
  @Allow() @ApiPropertyOptional({ description: 'Which sources to search', enum: ['docs', 'outcomes', 'all'], default: 'all' }) source?: 'docs' | 'outcomes' | 'all';
  @Allow() @ApiPropertyOptional({ description: 'Restrict the search to one of the project repositories, as owner/name' }) repo?: string;
  @Allow() @ApiPropertyOptional({ description: 'Only hits whose path starts with this prefix; relative, no `..`', minLength: 1, maxLength: 300 }) pathPrefix?: string;
  @Allow() @ApiPropertyOptional({ description: 'Maximum hits, 1-50', minimum: 1, maximum: 50, default: 20 }) limit?: number;
}

export class KnowledgeHitDto {
  @ApiProperty({ description: 'Which indexed source the chunk came from', enum: ['repo', 'outcome'] }) source: 'repo' | 'outcome';
  @ApiProperty() repoId: string;
  @ApiProperty() owner: string;
  @ApiProperty() name: string;
  @ApiProperty() path: string;
  @ApiProperty() sha: string;
  @ApiProperty({ description: 'GitHub heading anchor of the chunk; empty on the document summary chunk' }) anchor: string;
  @ApiProperty() headingPath: string;
  @ApiProperty() title: string;
  @ApiProperty() abstract: string;
  @ApiProperty({ description: 'The first 400 characters of the chunk text' }) snippet: string;
  @ApiPropertyOptional() status?: string;
  @ApiPropertyOptional() supersededBy?: string;
  @ApiProperty({ description: 'Reciprocal rank fusion score of the legs the chunk appears in' }) score: number;
  // US-005: outcome hits only — the job the chunk came from and its current state, read per search.
  @ApiPropertyOptional({ required: false, description: 'Outcome hits only: the job the chunk came from' }) jobId?: string;
  @ApiPropertyOptional({ required: false, description: 'Outcome hits only: the feature that job ran' }) feature?: string;
  @ApiPropertyOptional({ required: false, description: 'Outcome hits only: the outcome file the chunk came from', enum: ['report', 'decisions'] }) outcomeKind?: string;
  @ApiPropertyOptional({ required: false, description: 'Outcome hits only: the job’s current state' }) jobState?: string;
  @ApiPropertyOptional({ required: false, type: String, nullable: true, description: 'Outcome hits only: the state of the job’s newest fleet pull request' }) prState?: string | null;
  @ApiPropertyOptional({ required: false, type: String, nullable: true, description: 'Outcome hits only: that pull request’s url' }) prUrl?: string | null;
}

export class KnowledgeSearchResultDto {
  @ApiProperty({ description: 'True when the query embedding failed and only the lexical leg answered' }) lexicalOnly: boolean;
  @ApiProperty({ description: 'True when the project has no indexed repository chunk at all' }) empty: boolean;
  @ApiProperty({ type: [KnowledgeHitDto] }) hits: KnowledgeHitDto[];
}

/** US-002: `null` restores the default corpus; a list replaces it. */
export class KnowledgePatternsBodyDto {
  @Allow() @ApiProperty({ description: 'Markdown path patterns (1-50), or null for the default corpus', nullable: true, type: [String] })
  patterns: string[] | null;
}

export class KnowledgePatternsResultDto {
  @ApiProperty({ type: [String], description: 'The effective corpus patterns after the save' }) patterns: string[];
  @ApiProperty({ description: 'True when the patterns are the project’s own rather than the defaults' }) custom: boolean;
  @ApiProperty({ description: 'Repository passes queued by the save; 0 while indexing is disabled' }) queued: number;
}

/**
 * Fleet S5b (1c-c-D12): the project's repository knowledge. `POST search` is the member-facing hybrid search,
 * `GET repos` the index state of every repository, `POST repos/:repoId/reindex` the admin trigger and
 * `PUT patterns` (US-002) the admin replacement of the project's Markdown corpus patterns. The repository is
 * resolved through `KnowledgeIndexService` (the api-data layering rule), never by injecting the module-private
 * repository.
 *
 * Permissions P1d (US-007): every route declares `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards`,
 * so the membership guard resolves `request.projectContext` before the catalog key is checked.
 */
@ApiTags('fleet knowledge')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/knowledge')
export class ProjectKnowledgeController {
  constructor(
    private readonly searchService: KnowledgeSearchService,
    private readonly index: KnowledgeIndexService,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get('repos')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.knowledge.read')
  @ApiOperation({ summary: "Index state of the project's repositories (fleet.knowledge.read)" })
  @ApiResponse({ status: 200, type: KnowledgeRepoStatesDto })
  @ApiResponse({ status: 403, description: 'fleet.knowledge.read is missing' })
  async repos(@CurrentProject() project: ProjectContext) {
    const [states, patterns] = await Promise.all([
      this.index.listProjectStates(project.project.id),
      this.index.getPatterns(project.project.id),
    ]);
    return JsonResponse.Ok<KnowledgeRepoStatesDto>({
      enabled: this.config.knowledgeIndexEnabled,
      // US-002: the patterns the next pass of each repository will select with, beside the defaults.
      patterns: patterns.patterns,
      customPatterns: patterns.custom,
      defaultPatterns: [...DEFAULT_KNOWLEDGE_PATTERNS],
      // One entry per project repository, including GitLab and never-indexed ones (1c-c-D12).
      repos: states.map(toKnowledgeRepoState),
    });
  }

  @Put('patterns')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.knowledge.patterns.update')
  @ApprovalGated()
  @ApiOperation({ summary: "Replace the project's Markdown corpus patterns (fleet.knowledge.patterns.update)" })
  @ApiResponse({ status: 200, type: KnowledgePatternsResultDto })
  @ApiResponse({ status: 400, description: 'Invalid patterns body (knowledge.input)' })
  @ApiResponse({ status: 403, description: 'fleet.knowledge.patterns.update is missing' })
  async patterns(@Body() body: KnowledgePatternsBodyDto, @CurrentProject() project: ProjectContext) {
    const outcome = await this.routeGate.run<KnowledgePatternsResultDto>({
      key: 'fleet.knowledge.patterns.update', variant: KNOWLEDGE_ROUTE_VARIANTS.patterns,
      projectId: project.project.id,
      input: { slug: project.project.slug, projectId: project.project.id, patterns: body?.patterns },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('repos/:repoId/reindex')
  @HttpCode(202)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.knowledge.repo.reindex')
  @ApprovalGated()
  @ApiParam({ name: 'repoId', required: true, schema: { type: 'string' } })
  @ApiOperation({ summary: "Queue an index pass (fleet.knowledge.repo.reindex); executed: 202 { queued: true }, pending: 202 approval summary" })
  @ApiResponse({ status: 403, description: 'fleet.knowledge.repo.reindex is missing' })
  @ApiResponse({ status: 404, description: 'knowledge.repoNotFound' })
  @ApiResponse({ status: 409, description: 'knowledge.disabled' })
  async reindex(@Param('repoId') repoId: string, @CurrentProject() project: ProjectContext) {
    if (!this.config.knowledgeIndexEnabled) throw new ConflictAppException({}, 'knowledge.disabled');
    const outcome = await this.routeGate.run<KnowledgeReindexResultDto>({
      key: 'fleet.knowledge.repo.reindex', variant: KNOWLEDGE_ROUTE_VARIANTS.reindex,
      projectId: project.project.id,
      input: { slug: project.project.slug, projectId: project.project.id, repoId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('search')
  @HttpCode(200)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('fleet.knowledge.read')
  @ApiOperation({ summary: "Search the project's indexed repository docs (fleet.knowledge.read)" })
  @ApiResponse({ status: 200, type: KnowledgeSearchResultDto })
  @ApiResponse({ status: 400, description: 'Invalid search body (knowledge.input)' })
  @ApiResponse({ status: 403, description: 'fleet.knowledge.read is missing' })
  @ApiResponse({ status: 404, description: 'knowledge.repoNotFound' })
  @ApiResponse({ status: 409, description: 'knowledge.disabled, or knowledge.unavailable when the store is down' })
  async search(@Body() body: KnowledgeSearchBodyDto, @CurrentProject() project: ProjectContext) {
    if (!this.config.knowledgeIndexEnabled) throw new ConflictAppException({}, 'knowledge.disabled');
    const parsed = parseKnowledgeSearchInput(body);
    if (!parsed.ok) throw new ValidationAppException({ reason: parsed.reason }, 'knowledge.input');

    const { id: projectId } = project.project;
    const repoId = await this.repoId(projectId, parsed.value.repo);
    return JsonResponse.Ok<KnowledgeSearchResultDto>(await this.runSearch({
      projectId,
      query: parsed.value.query,
      // US-005: the service's own default is `all`, so the body decides only when it carries a source.
      ...(parsed.value.source === undefined ? {} : { source: parsed.value.source }),
      ...(repoId === undefined ? {} : { repoId }),
      ...(parsed.value.pathPrefix === undefined ? {} : { pathPrefix: parsed.value.pathPrefix }),
      limit: parsed.value.limit,
    }));
  }

  /** `owner/name` for one of the project's repositories, else 404 (a foreign or deleted repository is invisible). */
  private async repoId(projectId: string, repo: string | undefined): Promise<string | undefined> {
    if (repo === undefined) return undefined;
    const [owner, name] = repo.split('/');
    const found = await this.index.resolveProjectRepo(projectId, { owner, name });
    if (!found) throw new NotFoundAppException({}, 'knowledge.repoNotFound');
    return found.id;
  }

  /** An unavailable LanceDB is a store outage, not a client error (1c-c-D7 failure handling). */
  private async runSearch(input: KnowledgeSearchQuery): Promise<KnowledgeSearchResult> {
    try {
      return await this.searchService.search(input);
    } catch (error) {
      if (error instanceof KnowledgeStoreUnavailableError) throw new ConflictAppException({}, 'knowledge.unavailable');
      throw error;
    }
  }
}
