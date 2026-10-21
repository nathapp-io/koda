import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ProjectDomain } from '../../../projects/domain/project.domain';
import { ProjectsService } from '../../../projects/projects.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { PROJECT_COUNTS_READER, type ProjectCounts, type ProjectCountsReader } from '../assistant-tool-call.domain';
import { KODA_MY_PROJECTS } from '../koda-tool-descriptors';
import type { AssistantTool, ToolContext } from '../assistant-tool.types';

/**
 * Fleet S5b 1d2-D7: `koda_my_projects`, the one workspace-scoped tool. A WORKSPACE thread has no project of its own,
 * so this is the tool that names the projects the session's creator can reach; every other koda tool takes a
 * `project` argument in such a thread and the agent copies the slug from one of these lines.
 *
 * The tool reads only what the creator can reach, by construction — the executor runs a workspace-scoped tool with
 * no permission-key check (1d2-D5), so `findAllForPrincipal` is what keeps the answer inside the creator's
 * own reach. `ctx.projectId`/`ctx.projectSlug` are the home project's and are deliberately never read.
 */

/** 1d2-D7: the failed-job window, counted from `ctx.now`, the executor's clock. */
const FAILED_WINDOW_DAYS = 7;
/** 1d2-D7: the most projects one answer lists; the rest are reported as a count. */
const MAX_PROJECTS = 50;
const DAY_MS = 86_400_000;

/** 1d2-D7: slug ascending. A code-unit compare keeps the order independent of the host locale. */
function bySlugAscending(projects: readonly ProjectDomain[]): ProjectDomain[] {
  return [...projects].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** `<slug> open_tickets: <n> failed_jobs_7d: <n> pending_approvals: <n> /<slug>`, the project name fenced under it. */
function projectLines(ctx: ToolContext, project: ProjectDomain, counts: ProjectCounts | undefined): string[] {
  const open = counts?.openTickets ?? 0;
  const failed = counts?.failedJobs7d ?? 0;
  const pending = counts?.pendingApprovals ?? 0;
  return [
    `${project.slug} open_tickets: ${open} failed_jobs_7d: ${failed} pending_approvals: ${pending} /${project.slug}`,
    ctx.data(project.name),
  ];
}

/** `koda_my_projects` (1d2-D7): the creator's projects, at most 50, one line each plus the name under it. */
export function myProjectsTool(projects: ProjectsService, counts: ProjectCountsReader): AssistantTool<Record<string, never>> {
  return {
    descriptor: KODA_MY_PROJECTS,
    // Permissions P1 US-004: declared for the catalog's sake, never checked — a workspace-scope tool takes no key
    // check, because the listing is already the caller's reachable projects.
    key: 'project.read',
    scope: 'workspace',
    parse(): Record<string, never> {
      return {};
    },
    async execute(ctx: ToolContext): Promise<string> {
      const reachable = await projects.findAllForPrincipal(ctx.actor);
      if (reachable.length === 0) return 'no projects';
      const listed = bySlugAscending(reachable).slice(0, MAX_PROJECTS);
      const byProject = await counts.findProjectCounts(
        listed.map((project) => project.id),
        new Date(ctx.now.getTime() - FAILED_WINDOW_DAYS * DAY_MS),
      );
      const lines = listed.flatMap((project) => projectLines(ctx, project, byProject.get(project.id)));
      const notListed = reachable.length - listed.length;
      if (notListed > 0) lines.push(`more: ${notListed} projects not listed`);
      return lines.join('\n');
    },
  };
}

/** The US-003 tool group (1d2-D7): registers the workspace-scoped tool with the registry at bootstrap. */
@Injectable()
export class WorkspaceTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly projects: ProjectsService,
    @Inject(PROJECT_COUNTS_READER) private readonly counts: ProjectCountsReader,
  ) {}

  onModuleInit(): void {
    this.registry.register(myProjectsTool(this.projects, this.counts));
  }
}
