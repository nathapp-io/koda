/**
 * Fleet S5b 1d (US-004): the new-workspace-thread form helpers.
 *
 * A WORKSPACE thread is not project-scoped and has no repository, so the body carries neither
 * repository keys nor a thread `kind` (the route is POST /threads): a title, the cost cap, a native
 * backend and, only when the form picked one, the home project. The rules mirror
 * `lib/thread-create.ts` (the REPO/PROJECT form) — the same API DTO constraints, and the same i18n
 * keys, so the two forms read identically.
 */
import * as z from 'zod'
import { backendFieldIssues, toThreadBackend } from '~/lib/thread-create'
import type { AgentChoiceKey } from '~/lib/thread-create'
import type { ThreadBackend } from '~/lib/thread-types'

type Translate = (key: string) => string

/**
 * The form's parsed field values (the shape `buildWorkspaceThreadCreateSchema` produces):
 * `maxCostUsd` is already a number, and `homeProject` is the empty string for "Automatic"
 * (the API then picks the host project). `agent` is `native` or one ACP agent (US-011);
 * a WORKSPACE thread has no worktree, so it carries no mode.
 */
export interface WorkspaceThreadCreateValues {
  homeProject: string
  title: string
  agent: AgentChoiceKey
  model: string
  effort: string
  maxCostUsd: number
}

/** The create request body of POST /threads (create-workspace-thread.dto.ts). */
export interface CreateWorkspaceThreadBody {
  title: string
  maxCostUsd: number
  backend: ThreadBackend
  /** Absent for "Automatic": the API requires a reachable project for an explicit one. */
  homeProject?: string
}

export function buildWorkspaceThreadCreateSchema(t: Translate) {
  const invalid = t('fleet.threads.new.validation.invalid')
  return z.object({
    // The API's home project is 1..100 characters, and empty means "let the API choose".
    homeProject: z.string().max(100, invalid).default(''),
    title: z.string().min(1, t('fleet.threads.new.validation.title')).max(200, t('fleet.threads.new.validation.title'))
      .refine(value => !Array.from(value).some(character => {
        const code = character.charCodeAt(0)
        return code <= 0x1f || code === 0x7f
      }), t('fleet.threads.new.validation.title')),
    maxCostUsd: z.coerce.number().gt(0, invalid).max(10_000, invalid)
      .refine(value => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6, invalid),
    // The chosen agent decides which backend the body carries and which model/effort rules apply.
    agent: z.enum(['native', 'claude', 'codex', 'cursor']).default('native'),
    model: z.string().max(128).default(''),
    effort: z.string().max(32).default(''),
  }).superRefine((values, ctx) => {
    for (const issue of backendFieldIssues(values, t)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
    }
  })
}

export type WorkspaceThreadCreateFormValues = z.infer<ReturnType<typeof buildWorkspaceThreadCreateSchema>>

/** The POST /threads body: no repository keys and no mode, and an empty home project or effort is left out. */
export function toCreateWorkspaceThreadBody(values: WorkspaceThreadCreateValues): CreateWorkspaceThreadBody {
  const homeProject = values.homeProject.trim()
  return {
    title: values.title,
    // The schema already coerced the cap; Number() also tolerates a raw field value from a JS caller.
    maxCostUsd: Number(values.maxCostUsd),
    backend: toThreadBackend({
      agent: values.agent,
      model: values.model ?? '',
      effort: values.effort ?? '',
    }),
    // 'Automatic' is the empty string: an absent key lets the API choose the host project.
    ...(homeProject ? { homeProject } : {}),
  }
}
