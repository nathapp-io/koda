import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { KnowledgeStoreUnavailableError } from './knowledge-chunk-store';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeIndexQueue } from './knowledge-index.queue';
import { DEFAULT_KNOWLEDGE_PATTERNS, parseKnowledgePatterns } from './knowledge-patterns';
import { KnowledgeReindexResultDto, KnowledgeRepoStatesDto, toKnowledgeRepoState } from './knowledge-repo-state.dto';
import { KnowledgeSearchQuery, KnowledgeSearchResult, KnowledgeSearchService, parseKnowledgeSearchInput } from './knowledge-search.service';

export class KnowledgeSearchBodyDto {
  @Allow() @ApiProperty({ description: 'Search text, 1-500 characters', minLength: 1, maxLength: 500 }) query: string;
  @Allow() @ApiPropertyOptional({ description: 'Restrict the search to one of the project repositories, as owner/name' }) repo?: string;
  @Allow() @ApiPropertyOptional({ description: 'Only hits whose path starts with this prefix; relative, no `..`', minLength: 1, maxLength: 300 }) pathPrefix?: string;
  @Allow() @ApiPropertyOptional({ description: 'Maximum hits, 1-50', minimum: 1, maximum: 50, default: 20 }) limit?: number;
}

export class KnowledgeHitDto {
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
 */
@ApiTags('fleet knowledge')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/knowledge')
@UseGuards(ProjectMembershipGuard)
export class ProjectKnowledgeController {
  constructor(
    private readonly searchService: KnowledgeSearchService,
    private readonly index: KnowledgeIndexService,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
    private readonly queue: KnowledgeIndexQueue,
  ) {}

  @Get('repos')
  @ApiOperation({ summary: "Index state of the project's repositories (project member)" })
  @ApiResponse({ status: 200, type: KnowledgeRepoStatesDto })
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
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: "Replace the project's Markdown corpus patterns (global admin)" })
  @ApiResponse({ status: 200, type: KnowledgePatternsResultDto })
  @ApiResponse({ status: 400, description: 'Invalid patterns body (knowledge.input)' })
  async patterns(@Body() body: KnowledgePatternsBodyDto, @CurrentProject() project: ProjectContext) {
    const saved = await this.index.savePatterns(project.project.id, this.acceptPatterns(body?.patterns));
    // The routes answer while indexing is disabled: the list is saved, only the passes are skipped.
    return JsonResponse.Ok<KnowledgePatternsResultDto>({ ...saved, queued: await this.queuePasses(project.project.id) });
  }

  /** `null` is the explicit "restore the defaults" body; anything else must parse or the request is refused. */
  private acceptPatterns(input: unknown): string[] | null {
    if (input === null) return null;
    // This app compiles with `strictNullChecks: false`, where a boolean-literal discriminant does not narrow
    // (`ok` widens to boolean); this permissive local shape is what both branches of the parser guarantee, and
    // the parser's own spec pins them.
    const parsed: { ok: boolean; value?: string[]; reason?: string } = parseKnowledgePatterns(input);
    if (!parsed.ok) throw new ValidationAppException({ reason: parsed.reason }, 'knowledge.input');
    return parsed.value ?? [];
  }

  /** US-002: every repository re-selects under the new list; a disabled index queues nothing. */
  private async queuePasses(projectId: string): Promise<number> {
    if (!this.config.knowledgeIndexEnabled) return 0;
    const repos = await this.index.listProjectRepos(projectId);
    for (const repo of repos) this.queue.enqueue(repo.id, 'admin');
    return repos.length;
  }

  @Post('repos/:repoId/reindex')
  @HttpCode(202)
  @RequiredPermission('ADMIN')
  @ApiParam({ name: 'repoId', required: true, schema: { type: 'string' } })
  @ApiOperation({ summary: "Queue an index pass for one of the project's repositories (global admin)" })
  @ApiResponse({ status: 202, type: KnowledgeReindexResultDto })
  @ApiResponse({ status: 404, description: 'knowledge.repoNotFound' })
  @ApiResponse({ status: 409, description: 'knowledge.disabled' })
  async reindex(@Param('repoId') repoId: string, @CurrentProject() project: ProjectContext) {
    if (!this.config.knowledgeIndexEnabled) throw new ConflictAppException({}, 'knowledge.disabled');
    const repo = await this.index.resolveProjectRepo(project.project.id, { repoId });
    if (!repo) throw new NotFoundAppException({}, 'knowledge.repoNotFound');
    this.queue.enqueue(repo.id, 'admin');
    return JsonResponse.Ok<KnowledgeReindexResultDto>({ queued: true });
  }

  @Post('search')
  @HttpCode(200)
  @ApiOperation({ summary: "Search the project's indexed repository docs (project member)" })
  @ApiResponse({ status: 200, type: KnowledgeSearchResultDto })
  @ApiResponse({ status: 400, description: 'Invalid search body (knowledge.input)' })
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
