/**
 * Fleet S5a US-002: the Plan/Run dialog form. The schema mirrors the dispatch form's profile and
 * max-cost rules (`fleet-dispatch.ts`) so a mistake is caught before the request; the API stays the
 * authority. Values in, request body out: `toThreadHandoffBody` drops what the command does not send.
 */
import * as z from 'zod'
import { BASH_MODES } from '~/lib/fleet-bash-mode'
import type { BashMode } from '~/lib/fleet-types'
import { MAX_COST_USD, MAX_PROFILES, PROFILE_NAME_RE, RESERVED_PROFILE_PREFIX } from '~/lib/fleet-dispatch'

type Translate = (key: string) => string

/**
 * The Plan/Run form. `maxCostUsd` is coerced from the input string and every failure shares the
 * `fleet.dispatch.validation.maxCost` message, as the dispatch form does.
 */
export function buildThreadHandoffSchema(t: Translate) {
  return z.object({
    profiles: z.array(z.string()).max(MAX_PROFILES, t('fleet.dispatch.validation.profilesMax'))
      .refine(list => list.every(p => PROFILE_NAME_RE.test(p) && !p.startsWith(RESERVED_PROFILE_PREFIX)), t('fleet.dispatch.validation.profileName'))
      .refine(list => new Set(list).size === list.length, t('fleet.dispatch.validation.profileDuplicate')),
    maxCostUsd: z.coerce.number({ invalid_type_error: t('fleet.dispatch.validation.maxCost') })
      .gt(0, t('fleet.dispatch.validation.maxCost'))
      .max(MAX_COST_USD, t('fleet.dispatch.validation.maxCost'))
      .refine(n => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, t('fleet.dispatch.validation.maxCost')), // at most 4 decimals
    bashMode: z.enum(BASH_MODES),
  })
}

export type ThreadHandoffFormValues = z.infer<ReturnType<typeof buildThreadHandoffSchema>>

/** The API's defaults: no profiles, a 5 USD cap, raw bash (`THREAD_HANDOFF_DEFAULT_MAX_COST_USD`). */
export const THREAD_HANDOFF_DEFAULTS: ThreadHandoffFormValues = {
  profiles: [],
  maxCostUsd: 5,
  bashMode: 'raw',
}

/** The request body of POST .../plan and POST .../run (`PlanThreadDto`, and `RunThreadDto` adds bashMode). */
export interface ThreadHandoffBody {
  maxCostUsd: number
  profiles?: string[]
  bashMode?: BashMode
}

/** Form values -> request body. `bashMode` goes only with a RUN; `profiles` only when the list is non-empty. */
export function toThreadHandoffBody(values: ThreadHandoffFormValues, command: 'PLAN' | 'RUN'): ThreadHandoffBody {
  return {
    maxCostUsd: values.maxCostUsd,
    ...(values.profiles.length > 0 ? { profiles: [...values.profiles] } : {}),
    ...(command === 'RUN' ? { bashMode: values.bashMode } : {}),
  }
}
