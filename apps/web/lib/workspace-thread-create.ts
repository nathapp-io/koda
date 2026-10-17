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

type Translate = (key: string) => string

/**
 * The form's parsed field values (the shape `buildWorkspaceThreadCreateSchema` produces):
 * `maxCostUsd` is already a number, and `homeProject` is the empty string for "Automatic"
 * (the API then picks the host project).
 */
export interface WorkspaceThreadCreateValues {
  homeProject: string
  title: string
  model: string
  effort: string
  maxCostUsd: number
}

/** The create request body of POST /threads (create-workspace-thread.dto.ts). */
export interface CreateWorkspaceThreadBody {
  title: string
  maxCostUsd: number
  backend: { kind: 'native'; model: string; effort?: string }
  /** Absent for "Automatic": the API requires a reachable project for an explicit one. */
  homeProject?: string
}

export function buildWorkspaceThreadCreateSchema(t: Translate) {
  const required = t('fleet.threads.new.validation.required')
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
    model: z.string().min(1, required),
    effort: z.enum(['', 'low', 'medium', 'high', 'xhigh']),
  })
}

export type WorkspaceThreadCreateFormValues = z.infer<ReturnType<typeof buildWorkspaceThreadCreateSchema>>

/** The POST /threads body: no repository keys, and an empty home project or effort is left out. */
export function toCreateWorkspaceThreadBody(values: WorkspaceThreadCreateValues): CreateWorkspaceThreadBody {
  const homeProject = values.homeProject.trim()
  const effort = values.effort.trim()
  const backend: { kind: 'native'; model: string; effort?: string } = {
    kind: 'native',
    model: values.model,
    ...(effort ? { effort } : {}),
  }
  return {
    title: values.title,
    // The schema already coerced the cap; Number() also tolerates a raw field value from a JS caller.
    maxCostUsd: Number(values.maxCostUsd),
    backend,
    // 'Automatic' is the empty string: an absent key lets the API choose the host project.
    ...(homeProject ? { homeProject } : {}),
  }
}
